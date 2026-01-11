import React, {useState, useEffect, useMemo} from 'react';
import './style/style.css';
import './style/reservation.css';
import { Calendar, momentLocalizer } from 'react-big-calendar';
import moment from 'moment';
import 'react-big-calendar/lib/css/react-big-calendar.css';

const localizer = momentLocalizer(moment);

// max allowed number of hours for the reservation
const MAX_HOURS = 72;

const formatLocalDate = (date) => {
  const dObj = typeof date === 'string' ? new Date(date) : date;
  const y = dObj.getFullYear();
  const m = String(dObj.getMonth() + 1).padStart(2, '0');     //+1 because returns moths between 0 and 11
  const d = String(dObj.getDate()).padStart(2, '0');                //add 0 before if day between 1 and 9
  return `${y}-${m}-${d}`;
};
const formatLocalTime = (date) => {
  const dObj = typeof date === 'string' ? new Date(date) : date;
  const h = String(dObj.getHours()).padStart(2, '0');
  const min = String(dObj.getMinutes()).padStart(2, '0');
  return `${h}:${min}`;
};
//format timer duration
const formatDuration = (ms) => {
  if (ms <= 0) return '--:--';                                //timer expired
  const totalSeconds = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSeconds / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, '0');
  const s = String(totalSeconds % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

const getCurrentHour = () => new Date().getHours();
const generateTimeOptions = () => Array.from({ length: 24 }, (_, i) => `${String(i).padStart(2, '0')}:00`);
const timeOptions = generateTimeOptions(); //all hours from 00:00 to 23:00

const calculateEndTimeDetails = (startDate, startTime, endDate, endTime) => {
  if (!startDate || !startTime || !endDate || !endTime) return null;
  const startDateTime = new Date(`${startDate}T${startTime}:00`);
  const endDateTime = new Date(`${endDate}T${endTime}:00`);
  const durationMs = endDateTime.getTime() - startDateTime.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);
  if (durationHours <= 0 || durationHours > MAX_HOURS) return { valid: false }; //valid duration if it is in (0, MAX_HOURS]
  return { valid: true, start: startDateTime, end: endDateTime };
};

const CustomToolbar = ({ date, onNavigate }) => {
  const goToPrevMonth = () => {
    const newDate = moment(date).subtract(1, 'month').toDate();
    onNavigate('DATE', newDate);
  };

  const goToNextMonth = () => {
    const newDate = moment(date).add(1, 'month').toDate();
    onNavigate('DATE', newDate);
  };

  // format: "January 2026"
  const monthYear = moment(date).format('MMMM YYYY');

  return (
    <div className="calendar-custom-toolbar">
      <button type="button" onClick={goToPrevMonth} className="calendar-nav-button" aria-label="Previous month">
        ◀
      </button>
      <span className="calendar-month-label">{monthYear}</span>
      <button type="button" onClick={goToNextMonth} className="calendar-nav-button" aria-label="Next month"
      >
        ▶
      </button>
    </div>
  );
};

export default function Reservation({ username, isReservationActive }) {
  // calendar state
  const [allReservations, setAllReservations] = useState([]);               // every reservation
  const [selectedEvent, setSelectedEvent] = useState(null);                       // selected event to show details
  const [showEventModal, setShowEventModal] = useState(false);           // show/hide details
  const [calendarDate, setCalendarDate] = useState(new Date());                      // check calendar date
  const [showDayEventsModal, setShowDayEventsModal] = useState(false);   // show reservations if in the same day there are more reservations
  const [dayEvents, setDayEvents] = useState([]);                          // reservations in a day
  const [selectedDate, setSelectedDate] = useState(null);                         // date selected
  // form for reservation selection
  const [activeTab, setActiveTab] = useState('list');   // 'list' or 'new'

  // form data state
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');

  // reservation state
  const [statusMessage, setStatusMessage] = useState('');       // message after reservation
  const [isAvailable, setIsAvailable] = useState(null);
  const [timer, setTimer] = useState(null);                            // seconds to next starting reservation
  const [reservations, setReservations] = useState([]);         // reservations information stored in state
  const [now, setNow] = useState(Date.now());                           // a clock state used to update countdowns every second
  const [conflicts, setConflicts] = useState(null);                    // state of the reservations in conflict
  const [devices, setDevices] = useState([]);                   // devices list received from orchestrator
  const [selectedDevices, setSelectedDevices] = useState([]);   // array of asset_tag selected
  const [loadingDevices, setLoadingDevices] = useState(true); // loading state of the device area
  // minimum allowed date (today)
  const minDate = useMemo(() => formatLocalDate(new Date()), []);

  const isCurrentDate = startDate === minDate;
  const currentHour = getCurrentHour();
  // loading state per device (key -> boolean)
  const [loadingReachability, setLoadingReachability] = useState({});

  const availableStartTimes = useMemo(() => {
    if (!startDate) return timeOptions;                                 // return all hours 00 - 23, if start date is not assigned
    const currentHourNow = getCurrentHour();
    return timeOptions.filter(time => {
      const hour = parseInt(time.split(':')[0], 10);
      return isCurrentDate ? hour > currentHourNow : true;                      // return all hours after current hour if the selected date is the current date
    });
  }, [startDate, isCurrentDate]);

  const maxEndInfo = useMemo(() => {
    if (!startDate || !startTime) return null;
    const startDt = new Date(`${startDate}T${startTime}:00`);
    const maxEndDt = new Date(startDt.getTime() + MAX_HOURS * 3600 * 1000);   //end date = start date + MAX_HOURS
    return {
      startDt,
      maxEndDt,
      maxEndDateStr: formatLocalDate(maxEndDt),
      maxEndHour: maxEndDt.getHours()
    };
  }, [startDate, startTime]);

  const availableEndTimes = useMemo(() => {
    if (!endDate || !startDate || !startTime || !maxEndInfo) return [];
    const startHour = parseInt(startTime.split(':')[0], 10);
    const lastPossibleDate = maxEndInfo.maxEndDateStr;
    const lastPossibleHour = maxEndInfo.maxEndHour;
    // end date = start date --> hours available: from start hour + 1 to 23
    if (endDate === startDate) {
      return timeOptions.filter(t => parseInt(t.split(':')[0], 10) >= (startHour + 1));
    }
    // end date is not last possible date --> hours available: 00 - 23
    if (endDate !== lastPossibleDate) {
      return timeOptions.map(t => String(t));
    }
    // end date = last possible date --> hours available: 00 - start hour
    return timeOptions.filter(t => parseInt(t.split(':')[0], 10) <= lastPossibleHour).map(t => String(t));
  }, [endDate, startDate, startTime, maxEndInfo]);

  const finalDetails = useMemo(() => calculateEndTimeDetails(startDate, startTime, endDate, endTime), [startDate, startTime, endDate, endTime]);

  // keep a ticking clock to update every reservation countdown without creating many intervals
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // fetch reservations from server and set state
  const fetchUserReservations = async () => {
    try {
      const payload = { username };
      const resp = await fetch('/api/orchestrator/userResList', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok) {
        // server return a JSON
        const arr = Array.isArray(data) ? data : [];

        // sort by startDate desc
        arr.sort((a, b) => new Date(b.startDate).getTime() - new Date(a.startDate).getTime());
        setReservations(arr);
      } else {
        console.error('Error fetching reservations', resp.status);
        setReservations([]);
      }
    } catch (err) {
      console.error('Network error fetching reservations', err);
      setReservations([]);
    }
  };
  // when the page is loaded, call the function
  useEffect(() => {
    fetchUserReservations();
  }, []);

  // fetch all reservations for calendar view
  const fetchAllReservations = async () => {
    try {
      const resp = await fetch('/api/orchestrator/allReservations', { method: 'GET' });
      const data = await resp.json().catch(() => []);

      if (resp.ok && Array.isArray(data)) {
        setAllReservations(data);
      } else {
        console.error('Error fetching all reservations', resp.status);
        setAllReservations([]);
      }
    } catch (err) {
      console.error('Network error fetching all reservations', err);
      setAllReservations([]);
    }
  };

  useEffect(() => {
    fetchAllReservations();
  }, []);

  // call endpoint to check device reachability
  const handleDeviceClick = async (deviceKey, primaryIp) => {
    // if device is unreachable, do nothing
    const device = devices.find(d => (d.asset_tag || d.name) === deviceKey);
    if (!device) return;
    if (device.reachable === false) return;

    // avoid double request
    if (loadingReachability[deviceKey]) return;

    setLoadingReachability(prev => ({ ...prev, [deviceKey]: true }));

    try {
      // call to endpoint
      const url = `/api/orchestrator/verifyHostAvailability?ip=${encodeURIComponent(primaryIp || '')}`;
      const resp = await fetch(url, { method: 'GET' });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data && data.reachable === true) {
        // reachable device
        toggleSelectDevice(deviceKey);
      } else {
        // unreachable device
        setDevices(prev =>
          prev.map(d => {
            const key = `${d.asset_tag || d.name || ''}`;
            if (key === deviceKey) {
              return { ...d, reachable: false };
            }
            return d;
          })
        );
      }
    } catch (err) {
      // network error, we maintain unreachable or unchanged
      console.error('Error checking reachability', err);
      setDevices(prev =>
        prev.map(d => {
          const key = `${d.asset_tag || d.name || ''}`;
          if (key === deviceKey) {
            return { ...d, reachable: false };
          }
          return d;
        })
      );
    } finally {
      setLoadingReachability(prev => ({ ...prev, [deviceKey]: false }));
    }
  };

  const toggleSelectDevice = (deviceKey) => {
    setSelectedDevices(prev => {                                    // prev is previous value of selectedDevices
      if (prev.includes(deviceKey)) return prev.filter(k => k !== deviceKey);   // if the element deviceKey is present, return an array without deviceKey
      return [...prev, deviceKey];                                              // otherwise create an array with the same elements as before and add deviceKey at the end
    });
  };
  const handleSelectAll = () => {
    const reachableDevices = devices.filter(d => d.reachable !== false);
    const allSelected = reachableDevices.every(d =>
      selectedDevices.includes(d.asset_tag || d.name || '')
    );

    if (allSelected) {
      setSelectedDevices([]);
    } else {
      const allKeys = reachableDevices.map(d => d.asset_tag || d.name || '');
      setSelectedDevices(allKeys);
    }
  };

  // show available devices
  const fetchDevices = async () => {
      try {
        const resp = await fetch('/api/orchestrator/showDevices', { method: 'GET' });
        const data = await resp.json().catch(() => ({}));
        if (resp.ok && Array.isArray(data)) {
          setDevices(data);
        }  else {
          setDevices([]);
          console.error('Unexpected devices payload', data);
        }
      } catch (err) {
        console.error('Error fetching devices', err);
        setDevices([]);
      } finally {
        setLoadingDevices(false);
      }
    };
  // when the page is loaded, call the function
  useEffect(() => {
    fetchDevices();
  }, []);
  // delete reservation from GUI and from database
  const deleteReservation = async (reservationId) => {
    try {
      // disable optimistic duplicate clicks by local filter immediately (optimistic removal)
      setReservations(prev => prev.map(r => r.id === reservationId ? ({ ...r, deleting: true }) : r));

      const resp = await fetch('/api/orchestrator/deleteReservation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reservationId })
      });

      if (resp.ok) {
        setReservations(prev => prev.filter(r => r.id !== reservationId));   // remove the element with reservationId
        await fetchAllReservations();       // update calendar
      } else {
        const txt = await resp.text().catch(() => 'Server error');
        window.alert(`Error deleting reservation: ${resp.status} - ${txt}`);
        // rollback "deleting" flag, update an element in the list, for the reservationId element set deleting: false; the other remain the same
        setReservations(prev => prev.map(r => r.id === reservationId ? ({ ...r, deleting: false }) : r));
      }
    } catch (err) {
      window.alert('Impossible to delete reservation: ' + err.message);
      setReservations(prev => prev.map(r => r.id === reservationId ? ({ ...r, deleting: false }) : r));
    }
  };

  // pressing "Check Availability & Reserve"
  const handleCheckReservation = async () => {
    if (!finalDetails || !finalDetails.valid) return;
    setStatusMessage('Checking availability...');
    setIsAvailable(null);
    setTimer(null);
    setConflicts(null);
    setSelectedDevices([]);

    const devices = selectedDevices.slice();        //array of device selected by user
    const payload = { username, startDate, startTime, endDate, endTime, devices };

    try {
      const resp = await fetch('/api/orchestrator/checkReservation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data.ok) {
        setStatusMessage(`Testbed available! Reservation confirmed for ${payload.startDate} ${payload.startTime} - ${payload.endDate} ${payload.endTime}.`);
        setIsAvailable(true);
        // set timer of new reservation
        const startMs = finalDetails.start.getTime();
        const secondsToStart = Math.max(0, Math.floor((startMs - Date.now()) / 1000));
        if (secondsToStart > 0) setTimer(secondsToStart);
        setConflicts(null);
        // refresh reservation list from server
        await fetchUserReservations();
        await fetchAllReservations();
        setStartDate('');             //when the reservation succeed, input fields are empty
        setStartTime('');
      } else {
        if (resp.status === 409 && data) {

          await fetchAllReservations();         // update calendar

          if (Array.isArray(data.conflicts) && data.conflicts.length > 0) {
          setConflicts(data.conflicts);                                               // set reservation in conflict
          setStatusMessage('Requested slot overlaps existing reservations:');
          } else {
            setStatusMessage(data.message || 'Requested slot overlaps existing reservations');
            setConflicts(null);
          }
        } else if (data && data.message) {
          setStatusMessage(data.message);
          setConflicts(null);
        } else {
          setStatusMessage('Reservation failed (server error)');
          setConflicts(null);
        }
        setIsAvailable(false);
        setTimer(null);
      }
    } catch (err) {
      console.error('Network error', err);
      setStatusMessage('Network error while checking reservation');
      setIsAvailable(false);
      setTimer(null);
      setConflicts(null);
    }
  };

  // countdown used after creating a reservation
  useEffect(() => {
    if (timer === null || timer <= 0) return;
    const id = setInterval(() => {
      setTimer(prev => {
        if (!prev || prev <= 1) {
          clearInterval(id);
          setStatusMessage('Reservation for Testbed has started! You can now proceed to the Configuration phase.');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [timer]);

  // reset dependent fields when startDate/startTime changes
  useEffect(() => {
    setEndDate('');
    setEndTime('');
    if(startDate !== '') {            //reset message when the first field goes from empty to full
      setIsAvailable(null);
      setStatusMessage('');
    }
    setTimer(null);
  }, [startDate, startTime]);

  // if endDate changes, reset endTime and messages
  useEffect(() => {
    setEndTime('');
    if(startDate !== '') {
      setIsAvailable(null);    //reset message when the first field goes from empty to full
      setStatusMessage('');
    }
    setTimer(null);
  }, [endDate]);

  const isFormValid = startDate && startTime && endDate && endTime;
  const isButtonEnabled = isFormValid && finalDetails && finalDetails.valid && isAvailable === null && selectedDevices.length >= 2;

  // min/max values for input endDate
  const endMin = startDate || '';
  const endMax = maxEndInfo ? maxEndInfo.maxEndDateStr : '';

  // transform reservations into calendar events
  const calendarEvents = useMemo(() => {
    return allReservations.map(res => ({
      id: res.id,
      title: "Reserved", //res.username === username ? `My Reservation` : `Reserved by ${res.username}`,
      start: new Date(res.startDate),
      end: new Date(res.endDate),
      resource: {
        username: res.username,
        devices: res.devices,
        isCurrentUser: res.username === username
      }
    }));
  }, [allReservations, username]);

  const handleSelectEvent = (event) => {
    setSelectedEvent(event);
    setShowEventModal(true);
  };

  // custom event style
  const eventStyleGetter = (event) => {
    const isCurrentUser = event.resource.isCurrentUser;

    return {
      style: {
        backgroundColor: isCurrentUser ? '#4CAF50' : '#2196F3',
        borderColor: isCurrentUser ? '#388E3C' : '#1976D2',
        color: 'white',
        borderRadius: '5px',
        opacity: 0.8,
        border: '1px solid',
        display: 'block'
      }
    };
  };

  // handler for the click on "+X more"
  const handleShowMore = (events, date) => {
    setDayEvents(events);
    setSelectedDate(date);
    setShowDayEventsModal(true);
  };

  // prevent view change when click on show more
  const getDrilldownView = (targetDate, currentView) => {
    return currentView === 'month' ? 'month' : null;
  };

  return (
      <div className="reservation-page-container">
        <div className="row-top">
          <div className="card device-card">

            <h2 className="title"><img src="/Rack.png" alt="" className="rack-icon-img"/>Device list</h2>
            <div className="device-legend" aria-hidden="true">
              <span className="legend-item"><span className="legend-color spine"/> Spine</span>
              <span className="legend-item"><span className="legend-color leaf"/> Leaf</span>
              <span className="legend-item"><span className="legend-color host"/> Host</span>
            </div>
            <div className="device-list">
              {loadingDevices ? (
                <div className="loading-message">Loading devices...</div>
              ) : (
                devices.map((d) => {
                  // identifier for selection
                  const key = `${d.asset_tag || d.name || ''}`;
                  const role = (d.role || '').toLowerCase();
                  // choose icon
                  const icon = (role === 'leaf' || role === 'spine') ?
                      <img src="/networkSwitch.png" alt="" className="device-icon-img"/> : (role === 'host' ? '💻' : '🔹');

                  const displayText = d.asset_tag ? `${d.name} (${d.asset_tag})` : d.name;

                  return (
                      <label
                          key={key}
                          className={`device-item ${role || ''}`}
                      >
                        <span className="device-icon" aria-hidden="true">{icon}</span>
                        <span className="device-main">
                              {loadingReachability[key] && <span className="device-loading" aria-hidden="true">⏳</span>}
                          <span className="device-name">{displayText}</span>
                              <span className="device-ip">{d.primary_ip}</span>
                            </span>
                      </label>
                  );
                })
              )}
            </div>
          </div>

          <div className="calendar-card card">
            <h2 className="title">
              <span className="rack-icon-img">📅</span> Reservation Calendar
            </h2>

            <div className="calendar-container">
              <Calendar
                  localizer={localizer}
                  events={calendarEvents}
                  startAccessor="start"
                  endAccessor="end"
                  onSelectEvent={handleSelectEvent}
                  eventPropGetter={eventStyleGetter}
                  views={['month']}
                  view="month"
                  date={calendarDate}
                  onNavigate={(date) => setCalendarDate(date)}
                  components={{
                    toolbar: CustomToolbar
                  }}
                  popup={false}
                  onShowMore={handleShowMore}
                  getDrilldownView={getDrilldownView}
                  selected={null}
              />
            </div>

            {/* Legend */}
            <div className="calendar-legend">
              <div className="legend-item-cal">
                <div className="legend-color-cal user-reservation"></div>
                <span>My Reservations</span>
              </div>
              <div className="legend-item-cal">
                <div className="legend-color-cal other-reservation"></div>
                <span>Other Reservations</span>
              </div>
            </div>

            {/* Event Details Modal */}
            {showEventModal && selectedEvent && (
                <>
                  <div className="event-modal-overlay" onClick={() => setShowEventModal(false)}/>
                  <div className="event-modal">
                    <h3 className="event-modal-title">Reservation Details</h3>

                    {selectedEvent.resource.isCurrentUser && (
                        <p><strong>User:</strong> {selectedEvent.resource.username}</p>
                    )}
                    <p><strong>Start:</strong> {moment(selectedEvent.start).format('YYYY-MM-DD HH:mm')}</p>
                    <p><strong>End:</strong> {moment(selectedEvent.end).format('YYYY-MM-DD HH:mm')}</p>

                    {/* show devices only for current user's reservations */}
                    {selectedEvent.resource.isCurrentUser && selectedEvent.resource.devices.length > 0 && (
                        <div className="event-modal-devices">
                          <strong>Devices:</strong>
                          <div className="reservation-devices">
                            {selectedEvent.resource.devices.map((device, idx) => (
                                <span key={idx} className="device-pill">{device}</span>
                            ))}
                          </div>
                        </div>
                    )}
                    <button className="event-modal-close-btn" onClick={() => setShowEventModal(false)}>Close</button>
                  </div>
                </>
            )}
            {showDayEventsModal && (
              <>
                <div className="event-modal-overlay" onClick={() => setShowDayEventsModal(false)}/>
                <div className="event-modal day-events-modal">
                  <h3 className="event-modal-title">
                    Events on {selectedDate ? moment(selectedDate).format('MMMM D, YYYY') : ''}
                  </h3>

                  <div className="day-events-list">
                    {dayEvents.map((event, idx) => (
                      <div
                        key={idx}
                        className={`day-event-item ${event.resource.isCurrentUser ? 'current-user' : 'other-user'}`}
                        onClick={() => {
                          setShowDayEventsModal(false);
                          handleSelectEvent(event);
                        }}
                      >
                        <div className="day-event-title">{event.title}</div>
                        <div>
                          {moment(event.start).format('HH:mm')} - {moment(event.end).format('HH:mm')}
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    className="event-modal-close-btn"
                    onClick={() => setShowDayEventsModal(false)}
                  >
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="row-bottom-unified">
          <div className="card unified-reservation-card">
            {/* Tab Switcher */}
            <div className="tab-switcher">
              <button
                className={`tab-button ${activeTab === 'list' ? 'active' : ''}`}
                onClick={() => setActiveTab('list')}
              >
                My Reservations
              </button>
              <button
                className={`tab-button ${activeTab === 'new' ? 'active' : ''}`}
                onClick={() => setActiveTab('new')}
              >
                New Reservation
              </button>
            </div>
            {activeTab === 'list' && (
              <div className="tab-content">
                <h2 className="title">⏳ Reservations</h2>

                <div id="reservations-card-scrolling">
                  <ul id="user-reservations-list">
                    {reservations.length === 0 && (
                        <li>No reservation found</li>
                    )}

                    {reservations.map(res => {
                      const startDateObj = new Date(res.startDate);
                      const endDateObj = new Date(res.endDate);
                      const remainingMs = startDateObj.getTime() - now;
                      const isActive = remainingMs <= 0 && endDateObj.getTime() > now;
                      const isExpired = endDateObj.getTime() <= now;
                      const resDevices = Array.isArray(res.devices) ? res.devices : [];
                      return (
                          <li key={res.id} id={`reservation-item-${res.id}`}
                              className={`reservation-item ${isExpired || !isReservationActive ? 'expired' : isActive ? 'active' : ''}`}>
                            <div className="reservation-top-row">
                              <span className="reservation-info">
                                <span className="date">{formatLocalDate(startDateObj)}</span>
                                <span className="time">{formatLocalTime(startDateObj)}</span>
                                <span className="date-separator"> -- </span>
                                <span className="date">{formatLocalDate(endDateObj)}</span>
                                <span className="time">{formatLocalTime(endDateObj)}</span>
                              </span>

                              {resDevices.length > 0 && (
                                <div className="reservation-devices">
                                  {resDevices.map((tag, idx) => (
                                      <span key={`${tag}-${idx}`} className="device-pill">
                                    {tag}
                                  </span>
                                  ))}
                                </div>
                            )}

                              <span id={`timer-${res.id}`}
                                    className="timer-display-list">{isActive || isExpired ? '--:--' : formatDuration(remainingMs)}</span>

                              <button id={`delete-btn-${res.id}`} className="delete-button"
                                      disabled={isActive || isExpired || res.deleting}
                                      onClick={() => deleteReservation(res.id)} data-reservation-id={res.id}>
                                {res.deleting ? 'Deleting...' : 'Delete'}
                              </button>
                            </div>
                          </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            )}

            {/* Tab: New Reservation */}
            {activeTab === 'new' && (
              <div className="tab-content new-reservation-content">
                <div className="form-section time-selection-section">
                  <h2 className="title">📅 Reserve the Testbed</h2>

                  <div className="time-row">
                    <div className="input-group">
                      <label htmlFor="date-picker">Select Start Date:</label>
                      <input type="date" id="date-picker" className="input-field" value={startDate} min={minDate}
                             onChange={(e) => {
                               setStartDate(e.target.value);
                               setStartTime('');
                             }}/>
                    </div>

                    <div className="input-group">
                      <label htmlFor="start-time">Start Time:</label>
                      <select id="start-time" className="input-field" value={startTime}
                              onChange={(e) => setStartTime(e.target.value)} disabled={!startDate}>
                        <option value="">-- Select Start Time --</option>
                        {availableStartTimes.map(time => <option key={time} value={time}>{time}</option>)}
                      </select>
                    </div>
                  </div>

                  {isCurrentDate && startTime && parseInt(startTime.split(':')[0]) <= currentHour && (
                      <p className="error-text">Start time must be later than the current hour
                        ({currentHour.toString().padStart(2, '0')}:00).</p>
                  )}

                  <div className="time-row">
                    <div className="input-group">
                      <label htmlFor="end-date">Select End Date:</label>
                      <input type="date" id="end-date" className="input-field" value={endDate} min={endMin} max={endMax}
                             onChange={(e) => setEndDate(e.target.value)} disabled={!startDate || !startTime}/>
                    </div>

                    <div className="input-group">
                      <label htmlFor="end-time">End Time:</label>
                      <select id="end-time" className="input-field" value={endTime}
                              onChange={(e) => setEndTime(e.target.value)} disabled={!endDate}>
                        <option value="">-- Select End Time --</option>
                        {availableEndTimes.map(time => <option key={String(time)} value={String(time)}>{time}</option>)}
                      </select>
                    </div>
                  </div>

                  {endDate && (<small>Max reservation duration: {MAX_HOURS} hours</small>)}

                  {isFormValid && finalDetails && !finalDetails.valid && (
                      <p className="error-text">Reservation duration must be between 1 and {MAX_HOURS} hours.</p>
                  )}
                  {/* Device Selection Section */}
                  <div className="form-section device-selection-section">
                    <div className="section-header">
                      <h3 className="section-title">
                       Select Devices
                      </h3>
                      {!loadingDevices && (
                        <div className="select-all-container">
                          <label className="select-all-label">
                            <input
                              type="checkbox"
                              checked={devices.filter(d => d.reachable !== false).length > 0 &&
                                       devices.filter(d => d.reachable !== false)
                                         .every(d => selectedDevices.includes(d.asset_tag || d.name || ''))}
                              onChange={handleSelectAll}
                              className="select-all-checkbox"
                            />
                            <span>Select All</span>
                          </label>
                          <span className="selected-count">({selectedDevices.length} selected)</span>
                        </div>
                      )}
                    </div>

                    <div className="device-selection-grid">
                      {loadingDevices ? (
                        <div className="loading-message">Loading devices...</div>
                      ) : (
                        devices.map((d) => {
                          const key = `${d.asset_tag || d.name || ''}`;
                          const selected = selectedDevices.includes(key);
                          const isReachable = d.reachable !== false;

                          return (
                            <label key={key} className={`device-select-item ${!isReachable ? 'unavailable' : ''} ${selected ? 'selected' : ''}`}>
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={() => isReachable && handleDeviceClick(key, d.primary_ip)}
                                disabled={!isReachable || !!loadingReachability[key]}
                                className="device-select-checkbox"
                              />
                              {/* device icon e info */}
                              <span className={`availability-indicator ${isReachable ? 'available' : 'unavailable'}`}>
                                {loadingReachability[key] ? '⏳' : (d.asset_tag || d.name)}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>

                  <button className="submit-button reservation-button" onClick={handleCheckReservation}
                          disabled={!isButtonEnabled}>
                    Check Availability & Reserve
                  </button>

                  {statusMessage && (
                      <div className={`status-message ${isAvailable === true ? 'success' : isAvailable === false ? 'error' : 'pending'}`}>
                        <p>{statusMessage}</p>
                        {Array.isArray(conflicts) && conflicts.length > 0 && (
                            <ul className="conflict-list" style={{marginTop: 12, textAlign: 'left', paddingLeft: 16}}>
                              {conflicts.map((c, idx) => {
                                const start = `${c.startDate} ${c.startTime || ''}`.trim();
                                const end = `${c.endDate} ${c.endTime || ''}`.trim();
                                return (
                                    <li key={idx} className="conflict-item">{`${start} - ${end}`}</li>
                                );
                              })}
                            </ul>
                        )}
                      </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
  );}
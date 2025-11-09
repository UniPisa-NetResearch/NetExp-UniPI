import React, {useState, useEffect, useMemo} from 'react';
import './style/style.css';
import './style/reservation.css';

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

export default function Reservation({ username, isReservationActive }) {
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

  const toggleSelectDevice = (deviceKey) => {
    setSelectedDevices(prev => {                                    // prev is previous value of selectedDevices
      if (prev.includes(deviceKey)) return prev.filter(k => k !== deviceKey);   // if the element deviceKey is present, return an array without deviceKey
      return [...prev, deviceKey];                                              // otherwise create an array with the same elements as before and add deviceKey at the end
    });
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
        setStartDate('');             //when the reservation succeed, input fields are empty
        setStartTime('');
      } else {
        if (resp.status === 409 && data) {
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

  return (
    <div className="home-content-wrapper">

      <div className="card device-card side-by-side-container">

        <h2 className="title"><img src="/Rack.png" alt="" className="rack-icon-img"/> Select devices</h2>
        <div className="device-legend" aria-hidden="true">
          <span className="legend-item"><span className="legend-color spine"/> Spine</span>
          <span className="legend-item"><span className="legend-color leaf"/> Leaf</span>
          <span className="legend-item"><span className="legend-color host"/> Host</span>
        </div>
        <div className="device-list">
          {loadingDevices ? (
              <p>Loading devices...</p>
          ) : devices.length === 0 ? (
              <p>No devices found.</p>
          ) : (
              devices.map((d) => {
                // identifier for selection
                const key = `${d.asset_tag || d.name || ''}`;
                const role = (d.role || '').toLowerCase();
                const selected = selectedDevices.includes(key);

                // choose icon
                const icon = (role === 'leaf' || role === 'spine') ?
                    <img src="/networkSwitch.png" alt="" className="device-icon-img"/> : (role === 'host' ? '💻' : '🔹');
                return (
                    <label
                        key={key}
                        className={`device-item ${role || ''}`}
                        title={`${d.asset_tag || d.name || ''} ${d.primary_ip ? ' - ' + d.primary_ip : ''}`} /* information shown when the mouse is hover the element*/
                    >
                      <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelectDevice(key)}
                          className="device-checkbox"
                      />
                      <span className="device-icon" aria-hidden="true">{icon}</span>
                      <span className="device-main">
                        <span className="device-name">{d.name}</span>
                        <span className="device-ip">{d.primary_ip}</span>
                      </span>
                    </label>
                );
              })
          )}
        </div>
      </div>
      <div className="card  side-by-side-container">
        <h2 className="title">📅 Reserve the Testbed</h2>

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
          {isCurrentDate && startTime && parseInt(startTime.split(':')[0]) <= currentHour && (
              <p className="error-text">Start time must be later than the current hour
                ({currentHour.toString().padStart(2, '0')}:00).</p>
          )}
        </div>

        <div className="input-group">
          <label htmlFor="end-date">Select End Date:</label>
          <input type="date" id="end-date" className="input-field" value={endDate} min={endMin} max={endMax}
                 onChange={(e) => setEndDate(e.target.value)} disabled={!startDate || !startTime}/>
          {endDate && (<small>Max reservation duration: {MAX_HOURS} hours</small>)}
        </div>

        <div className="input-group">
          <label htmlFor="end-time">End Time:</label>
          <select id="end-time" className="input-field" value={endTime}
                  onChange={(e) => setEndTime(e.target.value)} disabled={!endDate}>
            <option value="">-- Select End Time --</option>
            {availableEndTimes.map(time => <option key={String(time)} value={String(time)}>{time}</option>)}
          </select>
          {isFormValid && finalDetails && !finalDetails.valid && (
            <p className="error-text">Reservation duration must be between 1 and {MAX_HOURS} hours.</p>
          )}
        </div>

        <button className="submit-button reservation-button" onClick={handleCheckReservation} disabled={!isButtonEnabled}>
          Check Availability & Reserve
        </button>

        {statusMessage && (
          <div className={`status-message ${isAvailable === true ? 'success' : isAvailable === false ? 'error' : 'pending'}`}>
            <p>{statusMessage}</p>
              {Array.isArray(conflicts) && conflicts.length > 0 && (
              <ul className="conflict-list" style={{ marginTop: 12, textAlign: 'left', paddingLeft: 16 }}>
                {conflicts.map((c, idx) => {
                  const start = `${c.startDate} ${c.startTime || ''}`.trim();
                  const end = `${c.endDate} ${c.endTime || ''}`.trim();
                  return (
                    <li key={idx} className="conflict-item">
                      {`${start} - ${end}`}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      <div id="reservations-list-container" className="card side-by-side-container">
        <h2 className="title">⏳ Your Reservations</h2>

        <div id="reservations-card-scrolling">
          <ul id="user-reservations-list">
            {reservations.length === 0 && (
              <li>No reservation found</li>
            )}

            {reservations.map(res => {
              const startDateObj = new Date(res.startDate);
              const endDateObj = new Date(res.endDate);
              const remainingMs = startDateObj.getTime() - now;
               const isActive = remainingMs <= 0 &&
                   endDateObj.getTime() > now;
              const isExpired = endDateObj.getTime() <= now;
              const resDevices = Array.isArray(res.devices) ? res.devices : [];
              return (
                  <li key={res.id} id={`reservation-item-${res.id}`}
                      className={`reservation-item ${isExpired || !isReservationActive ? 'expired' : isActive ? 'active' : ''}`}>
                    <div className="reservation-top-row">
                      <span className="reservation-info">
                        <div className="date-line start">
                          <span className="date">{formatLocalDate(startDateObj)}</span>&nbsp;
                          <span className="time">{formatLocalTime(startDateObj)}</span>
                        </div>
                        <div className="date-line end">
                          <span className="date">{formatLocalDate(endDateObj)}</span>&nbsp;
                          <span className="time">{formatLocalTime(endDateObj)}</span>
                        </div>
                      </span>

                      <span id={`timer-${res.id}`}
                            className="timer-display-list">{isActive || isExpired ? '--:--' : formatDuration(remainingMs)}</span>

                      <button id={`delete-btn-${res.id}`} className="delete-button" disabled={isActive || isExpired || res.deleting}
                              onClick={() => deleteReservation(res.id)} data-reservation-id={res.id}>
                        {res.deleting ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                      {resDevices.length > 0 && (
                          <div className="reservation-devices">
                            {resDevices.map((tag, idx) => (
                                <span key={`${tag}-${idx}`} className="device-pill">
                                  {tag}
                                </span>
                            ))}
                          </div>
                      )}
                  </li>
            );
            })}
            </ul>
        </div>
      </div>
    </div>
  );
}
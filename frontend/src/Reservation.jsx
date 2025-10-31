import React, { useState, useEffect, useMemo } from 'react';
import './style/style.css';

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

export default function Reservation({ username }) {
  // form data state
  const [startDate, setStartDate] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endDate, setEndDate] = useState('');
  const [endTime, setEndTime] = useState('');

  // reservation state
  const [statusMessage, setStatusMessage] = useState('');
  const [isAvailable, setIsAvailable] = useState(null);
  const [timer, setTimer] = useState(null);                    // seconds to next starting reservation
  const [reservations, setReservations] = useState([]); // reservations stored in state
  const [now, setNow] = useState(Date.now());                   // a clock state used to update countdowns every second
  const [conflicts, setConflicts] = useState(null);            // state of the reservations in conflict

  // minimum allowed date (today)
  const minDate = useMemo(() => formatLocalDate(new Date()), []);

  const isCurrentDate = startDate === minDate;
  const currentHour = getCurrentHour();

  const availableStartTimes = useMemo(() => {
    if (!startDate) return timeOptions;
    const currentHourNow = getCurrentHour();
    return timeOptions.filter(time => {
      const hour = parseInt(time.split(':')[0], 10);
      return isCurrentDate ? hour > currentHourNow : true;
    });
  }, [startDate, isCurrentDate]);

  const maxEndInfo = useMemo(() => {
    if (!startDate || !startTime) return null;
    const startDt = new Date(`${startDate}T${startTime}:00`);
    const maxEndDt = new Date(startDt.getTime() + MAX_HOURS * 3600 * 1000);
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

    if (endDate === startDate) {
      return timeOptions.filter(t => parseInt(t.split(':')[0], 10) >= (startHour + 1));
    }

    if (endDate !== lastPossibleDate) {
      return timeOptions.map(t => String(t));
    }

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
        // server might return either an array or { ok: true, reservations: [...] }
        const arr = Array.isArray(data) ? data : [];

        // sort by startDate asc
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

  useEffect(() => {
    fetchUserReservations();
  }, []);

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
        setReservations(prev => prev.filter(r => r.id !== reservationId));
      } else {
        const txt = await resp.text().catch(() => 'Server error');
        window.alert(`Error deleting reservation: ${resp.status} - ${txt}`);
        // rollback "deleting" flag
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

    const devices = ['testbed-1'];
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
        // set reservationData-like logic (to keep previous UX of starting timer)
        const startMs = finalDetails.start.getTime();
        const secondsToStart = Math.max(0, Math.floor((startMs - Date.now()) / 1000));
        if (secondsToStart > 0) setTimer(secondsToStart);
        setConflicts(null);
        // refresh authoritative list from server (recommended)
        // this avoids DOM-manipulation complexity and keeps state consistent
        await fetchUserReservations();
      } else {
        if (resp.status === 409 && data) {
          if (Array.isArray(data.conflicts) && data.conflicts.length > 0) {
          setConflicts(data.conflicts);
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

  // countdown effect (for the smaller "timer" used after creating a reservation)
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
    setIsAvailable(null);
    setStatusMessage('');
    setTimer(null);
  }, [startDate, startTime]);

  // if endDate changes, reset endTime and messages
  useEffect(() => {
    setEndTime('');
    setIsAvailable(null);
    setStatusMessage('');
    setTimer(null);
  }, [endDate]);

  const isFormValid = startDate && startTime && endDate && endTime;
  const isButtonEnabled = isFormValid && finalDetails && finalDetails.valid && isAvailable === null;

  // min/max values for input endDate
  const endMin = startDate || '';
  const endMax = maxEndInfo ? maxEndInfo.maxEndDateStr : '';

  return (
    <div className="home-content-wrapper">
      <div className="card reservation-card side-by-side-container">
        <h2 className="title">📅 Reserve the Testbed</h2>

        <div className="input-group">
          <label htmlFor="date-picker">Select Start Date:</label>
          <input type="date" id="date-picker" className="input-field" value={startDate} min={minDate}
                 onChange={(e) => { setStartDate(e.target.value); setStartTime(''); }} />
        </div>

        <div className="input-group">
          <label htmlFor="start-time">Start Time:</label>
          <select id="start-time" className="input-field" value={startTime}
                  onChange={(e) => setStartTime(e.target.value)} disabled={!startDate}>
            <option value="">-- Select Start Time --</option>
            {availableStartTimes.map(time => <option key={time} value={time}>{time}</option>)}
          </select>
          {isCurrentDate && startTime && parseInt(startTime.split(':')[0]) <= currentHour && (
            <p className="error-text">Start time must be later than the current hour ({currentHour.toString().padStart(2, '0')}:00).</p>
          )}
        </div>

        <div className="input-group">
          <label htmlFor="end-date">Select End Date:</label>
          <input type="date" id="end-date" className="input-field" value={endDate} min={endMin} max={endMax}
                 onChange={(e) => setEndDate(e.target.value)} disabled={!startDate || !startTime} />
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
              const isPast = remainingMs <= 0;
              return (
                <li key={res.id} id={`reservation-item-${res.id}`} className={`reservation-item ${isPast ? 'expired' : ''}`}>
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
                        className="timer-display-list">{isPast ? '--:--' : formatDuration(remainingMs)}</span>

                  <button id={`delete-btn-${res.id}`} className="delete-button" disabled={isPast || res.deleting}
                          onClick={() => deleteReservation(res.id)} data-reservation-id={res.id}>
                    {res.deleting ? 'Deleting...' : 'Delete'}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
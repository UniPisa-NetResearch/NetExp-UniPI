import React, {useState, useEffect, useMemo} from 'react';
import './style/style.css';

// max allowed number of hours for the reservation
const MAX_HOURS = 72;

const formatLocalDate = (date) => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0'); // getMonth() parte da 0
  const d = String(date.getDate()).padStart(2, '0');      // getDate() -> giorno del mese
  return `${y}-${m}-${d}`;
};

// get the correct current hour
const getCurrentHour = () => new Date().getHours();

// function that generates the hour booking options from 0 to 23
const generateTimeOptions = () => {
    return Array.from({ length: 24 }, (_, i) => {
        const hour = i.toString().padStart(2, '0'); //add 0 if the hour is one digit
        return `${hour}:00`;
    });
};
const timeOptions = generateTimeOptions();

const calculateEndTimeDetails = (startDate, startTime, endDate, endTime) => {
    if (!startDate || !startTime || !endDate || !endTime) return null;

    const startDateTime = new Date(`${startDate}T${startTime}:00`);
    const endDateTime = new Date(`${endDate}T${endTime}:00`);

    // Check chronological order and max duration
    const durationMs = endDateTime.getTime() - startDateTime.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours <= 0 || durationHours > MAX_HOURS) {
        return { valid: false }; // Not valid
    }

    return {
        valid: true,
        start: startDateTime,
        end: endDateTime,
    };
};

const Reservation = ({ username }) => {
    const [startDate, setStartDate] = useState('');
    const [startTime, setStartTime] = useState('');
    const [endDate, setEndDate] = useState('');
    const [endTime, setEndTime] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [isAvailable, setIsAvailable] = useState(null); // null, true, false
    const [timer, setTimer] = useState(null);
    const [reservationData, setReservationData] = useState(null); // reserved devices

    // minimum allowed date (today)
    const minDate = useMemo(() => formatLocalDate(new Date()), []);

    // validation and button enabling
    const isCurrentDate = startDate === minDate;
    const currentHour = getCurrentHour();

    // only hours (without minutes) >= current hour  (if same day)
    const availableStartTimes = useMemo(() => {
        if (!startDate) return timeOptions;

        const currentHour = getCurrentHour();

        return timeOptions.filter(time => {
            const hour = parseInt(time.split(':')[0]);
            // if the selected day is today, start hour must be >= current hour + 1
            // if the selected day is not today, every hour is available
            return isCurrentDate ? hour > currentHour : true;
        });
    }, [startDate, isCurrentDate]);

    // compute maxEndDateTime based on startDate+startTime
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

    // compute available end times depending on which endDate is selected
    const availableEndTimes = useMemo(() => {
        if (!endDate || !startDate || !startTime || !maxEndInfo) return [];

        const startHour = parseInt(startTime.split(':')[0], 10);
        const lastPossibleDate = maxEndInfo.maxEndDateStr;
        const lastPossibleHour = maxEndInfo.maxEndHour;

        if (endDate === startDate) {
            // same day: hours from startHour + 1 ... 23
            return timeOptions.filter(t => parseInt(t.split(':')[0], 10) >= (startHour + 1));
        }

        if (endDate !== lastPossibleDate) {
            // intermediate day: all hours allowed (from 00 to 23)
            return timeOptions.map(t => String(t));
        }

        // endDate is the last possible date: allow hours from 00 up to lastPossibleHour (inclusive only if minute 0)
        return timeOptions.filter(t => parseInt(t.split(':')[0], 10) <= lastPossibleHour).map(t => String(t));
    }, [endDate, startDate, startTime, maxEndInfo]);

    const finalDetails = useMemo(() => {
        // Ora viene usata per ogni cambio di data/ora
        return calculateEndTimeDetails(startDate, startTime, endDate, endTime);
    }, [startDate, startTime, endDate, endTime]);


    // check if all fields are selected
    const isFormValid = startDate && startTime && endDate && endTime;

    const isButtonEnabled = isFormValid && finalDetails && finalDetails.valid && isAvailable === null;

    const handleCheckReservation = async () => {
        if (!isButtonEnabled || !finalDetails || !finalDetails.valid) return;

        setStatusMessage("Checking availability...");
        setIsAvailable(null);
        setTimer(null);
        setReservationData(null);

        // Simula i device prenotati
        const devices = ['testbed-1'];

        const payload = {
            username: username,
            startDate: startDate,
            startTime: startTime,
            endDate: endDate,
            endTime: endTime,
            devices: devices
        };

        try {
            const resp = await fetch('/api/orchestrator/checkReservation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const data = await resp.json().catch(() => ({}));

            if (resp.ok && data.ok) {
                // reservation confirmed
                setStatusMessage(`Testbed available! Reservation confirmed for ${payload.startDate} ${payload.startTime} - ${payload.endDate} ${payload.endTime}.`);
                setIsAvailable(true);
                setReservationData({ finalDetails, devices: payload.devices });

                // start timer based on finalDetails.start
                const reservationStartTime = finalDetails.start.getTime();
                const now = new Date().getTime();
                const initialDelay = reservationStartTime > now ? reservationStartTime - now : 0;
                setTimer(Math.max(0, Math.ceil(initialDelay / 1000))); // in seconds
            } else {
                // errors e conflicts management (409)
                if (resp.status === 409 && data && data.conflict) {
                    const c = data.conflict;
                    const conflictMsg = `Requested slot overlaps existing reservation (id=${c.id}) by ${c.username}: ${c.startDate} ${c.startTime} - ${c.endDate} ${c.endTime}`;
                    setStatusMessage(conflictMsg);
                } else if (data && data.message) {
                    setStatusMessage(data.message);
                } else {
                    setStatusMessage('Reservation failed (server error)');
                }
                setIsAvailable(false);
                setTimer(null);
            }
        } catch (err) {
            console.error('Network error', err);
            setStatusMessage('Network error while checking reservation');
            setIsAvailable(false);
            setTimer(null);
        }
    };

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

    useEffect(() => {
        if (timer === null || timer <= 0) return;

        const intervalId = setInterval(() => {
            setTimer(prevTimer => {
                if (prevTimer <= 1) {
                    clearInterval(intervalId);
                    setStatusMessage(`Reservation for Testbed has started! You can now proceed to the Configuration phase.`);
                    return 0;
                }
                return prevTimer - 1;
            });
        }, 1000);

        return () => clearInterval(intervalId);
    }, [timer]);


    // format timer (h:m:s)
    const formatTime = (seconds) => {
        const h = String(Math.floor(seconds / 3600)).padStart(2, '0');
        const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
        const s = String(seconds % 60).padStart(2, '0');
        return `${h}:${m}:${s}`;
    };

    // min/max values for input endDate
  const endMin = startDate || '';
  const endMax = maxEndInfo ? maxEndInfo.maxEndDateStr : '';

    return (
        <div className="container home-content">
            <div className="card reservation-card">
                <h2 className="title">📅 Reserve the Testbed</h2>

                {/* date selection */}
                <div className="input-group">
                    <label htmlFor="date-picker">Select Start Date:</label>
                    <input
                        type="date"
                        id="date-picker"
                        className="input-field"
                        value={startDate}
                        min={minDate}
                        onChange={(e) => {
                            setStartDate(e.target.value);
                            setStartTime('');
                        }}
                    />
                </div>

                {/* start hour selection */}
                <div className="input-group">
                    <label htmlFor="start-time">Start Time:</label>
                    <select
                        id="start-time"
                        className="input-field"
                        value={startTime}
                        onChange={(e) => {
                            setStartTime(e.target.value);
                        }}
                        disabled={!startDate}
                    >
                        <option value="">-- Select Start Time --</option>
                        {availableStartTimes.map(time => (
                            <option key={time} value={time}>{time}</option>
                        ))}
                    </select>
                    {isCurrentDate && startTime && parseInt(startTime.split(':')[0]) <= currentHour && (
                        <p className="error-text">Start time must be later than the current hour ({currentHour.toString().padStart(2, '0')}:00).</p>
                    )}
                </div>

                {/* end date selection */}
                <div className="input-group">
                    <label htmlFor="end-date">Select End Date:</label>
                    <input
                        type="date"
                        id="end-date"
                        className="input-field"
                        value={endDate}
                        min={endMin}
                        max={endMax}
                        onChange={(e) => setEndDate(e.target.value)}
                        disabled={!startDate || !startTime}
                    />
                    {endDate && (
                        <small>Max reservation duration: {MAX_HOURS} hours</small>

                    )}
                </div>

                {/* end hour selection */}
                <div className="input-group">
                    <label htmlFor="end-time">End Time:</label>
                    <select
                        id="end-time"
                        className="input-field"
                        value={endTime}
                        onChange={(e) => {
                            setEndTime(e.target.value);
                        }}
                        disabled={!endDate}
                    >
                        <option value="">-- Select End Time --</option>
                        {availableEndTimes.map(time => (
                            <option key={String(time)} value={String(time)}>{time}</option>
                        ))}
                    </select>
                    {isFormValid && finalDetails && !finalDetails.valid && (
                        <p className="error-text">Reservation duration must be between 1 and {MAX_HOURS} hours.</p>
                    )}
                </div>

                {/* submit button */}
                <button
                    className="submit-button reservation-button"
                    onClick={handleCheckReservation}
                    disabled={!isButtonEnabled}
                >
                    Check Availability & Reserve
                </button>

                {/* timer and messages */}
                {statusMessage && (
                    <div className={`status-message ${isAvailable === true ? 'success' : isAvailable === false ? 'error' : 'pending'}`}>
                        <p>{statusMessage}</p>

                        {timer !== null && isAvailable === true && (
                            <div className="timer-display">
                                Time remaining until start: **{formatTime(timer)}**
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

export default Reservation;
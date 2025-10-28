import React, {useState, useEffect, useMemo} from 'react';
import './style/style.css';

// get the correct current hour
const getCurrentHour = () => new Date().getHours();

// format date in YYYY-MM-DD
const formatDate = (date) => date.toISOString().split('T')[0];

// function that generates the hour booking options from 0 to 23
const generateTimeOptions = () => {
    return Array.from({ length: 24 }, (_, i) => {
        const hour = i.toString().padStart(2, '0'); //add 0 if the hour is one digit
        return `${hour}:00`;
    });
};
const timeOptions = generateTimeOptions();

const calculateEndTimeDetails = (startDate, startTime, endTime) => {
    if (!startDate || !startTime || !endTime) return null;

    const startDateTime = new Date(`${startDate}T${startTime}:00`);
    const startHour = parseInt(startTime.split(':')[0]);
    const endHour = parseInt(endTime.split(':')[0]);
    const endDateTime = new Date(startDateTime);

    // set end hour
    endDateTime.setHours(endHour, 0, 0, 0);

    // end hour is <= start hour (20:00 -> 08:00)
    // if endHour <= startHour, the reservation ends the next day
    if(endHour <= startHour) {
        endDateTime.setDate(endDateTime.getDate() + 1);
    }

    // Check max duration
    const durationMs = endDateTime.getTime() - startDateTime.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours <= 0 || durationHours > 24) {
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
    const [endTime, setEndTime] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [isAvailable, setIsAvailable] = useState(null); // null, true, false
    const [timer, setTimer] = useState(null);
    const [reservationData, setReservationData] = useState(null); // reserved devices

    // minimum allowed date (today)
    const minDate = useMemo(() => formatDate(new Date()), []);

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

    const finalDetails = useMemo(() => {
        // Ora viene usata per ogni cambio di data/ora
        return calculateEndTimeDetails(startDate, startTime, endTime);
    }, [startDate, startTime, endTime]);

    const formatLocalDate = (date) => {
      const y = date.getFullYear();         // gets the year (ex 2025)
      const m = String(date.getMonth() + 1).padStart(2, '0');  // +1 because getMonth() starts from 0, padStart(2, '0') transforms the number in string and add 0 if the number is between 1 and 9
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    };
    // check if all fields are selected
    const isFormValid = startDate && startTime && endTime;

    const isButtonEnabled = isFormValid && finalDetails && finalDetails.valid && isAvailable === null;

    const handleCheckReservation = async () => {
        if (!isButtonEnabled || !finalDetails || !finalDetails.valid) return;

        setStatusMessage("Checking availability...");
        setIsAvailable(null);
        setTimer(null);
        setReservationData(null);

        //setEndDate(finalDetails.end.toISOString().slice(0, 10))
        const endDate = formatLocalDate(finalDetails.end);

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
                // prenotazione confermata
                setStatusMessage(`Testbed available! Reservation confirmed for ${payload.startDate} ${payload.startTime} - ${payload.endDate} ${payload.endTime}.`);
                setIsAvailable(true);
                setReservationData({ finalDetails, devices: payload.devices });

                // start timer basato sul finalDetails.start
                const reservationStartTime = finalDetails.start.getTime();
                const now = new Date().getTime();
                const initialDelay = reservationStartTime > now ? reservationStartTime - now : 0;
                setTimer(Math.max(0, Math.ceil(initialDelay / 1000))); // in seconds
            } else {
                // gestione errori e conflitti (409)
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

    return (
        <div className="container home-content">
            <div className="card reservation-card">
                <h2 className="title">📅 Reserve the Testbed</h2>

                {/* date selection */}
                <div className="input-group">
                    <label htmlFor="date-picker">Select Date:</label>
                    <input
                        type="date"
                        id="date-picker"
                        className="input-field"
                        value={startDate}
                        min={minDate}
                        onChange={(e) => {
                            setStartDate(e.target.value);
                            setStartTime('');
                            setEndTime('');
                            setIsAvailable(null);
                            setStatusMessage('');
                            setTimer(null);
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
                            setEndTime('');
                            setIsAvailable(null);
                            setStatusMessage('');
                            setTimer(null);
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

                {/* end hour selection */}
                <div className="input-group">
                    <label htmlFor="end-time">End Time:</label>
                    <select
                        id="end-time"
                        className="input-field"
                        value={endTime}
                        onChange={(e) => {
                            setEndTime(e.target.value);
                            setIsAvailable(null);
                            setStatusMessage('');
                            setTimer(null);
                        }}
                        disabled={!startTime}
                    >
                        <option value="">-- Select End Time --</option>
                        {timeOptions.map(time => (
                            <option key={time} value={time}>{time}</option>
                        ))}
                    </select>
                    {isFormValid && finalDetails && !finalDetails.valid && (
                        <p className="error-text">Reservation duration must be between 1 and 24 hours.</p>
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
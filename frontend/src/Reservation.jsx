import React, {useState, useEffect, useMemo, useCallback} from 'react';
import './style/style.css';

// get the correct current hour
const getCurrentHour = () => new Date().getHours();

// format date in YYYY-MM-DD
const formatDate = (date) => date.toISOString().split('T')[0];

// function that generates the hour booking options from 0 to 23
const generateTimeOptions = () => {
    return Array.from({ length: 24 }, (_, i) => {
        const hour = i.toString().padStart(2, '0');
        return `${hour}:00`;
    });
};
const timeOptions = generateTimeOptions();

const calculateEndTimeDetails = (selectedDate, startTime, endTime) => {
    if (!selectedDate || !startTime || !endTime) return null;

    const startDateTime = new Date(`${selectedDate}T${startTime}:00`);
    const startHour = parseInt(startTime.split(':')[0]);
    const endHour = parseInt(endTime.split(':')[0]);

    // L'ora di fine è "prima" o "uguale" all'ora di inizio (es. 20:00 -> 08:00)
    // Se endHour <= startHour, significa che finisce il giorno dopo.
    const isNextDay = endHour <= startHour;

    const endDateTime = new Date(startDateTime);

    // Resetta l'ora e i minuti del giorno di inizio
    endDateTime.setHours(endHour, 0, 0, 0);

    if (isNextDay) {
        // Se è il giorno dopo, aggiunge un giorno
        if(endHour <= startHour) {
            endDateTime.setDate(endDateTime.getDate() + 1);
        }
    }

    // Controlla la durata (max 24 ore)
    const durationMs = endDateTime.getTime() - startDateTime.getTime();
    const durationHours = durationMs / (1000 * 60 * 60);

    if (durationHours <= 0 || durationHours > 24) {
        return { valid: false }; // Non valido
    }

    return {
        valid: true,
        start: startDateTime,
        end: endDateTime,
        isNextDay: isNextDay && endHour <= startHour,
        formattedEndDate: isNextDay && endHour <= startHour ? formatDate(endDateTime) : selectedDate,
    };
};

const Reservation = ({ username }) => {
    const [selectedDate, setSelectedDate] = useState('');
    const [startTime, setStartTime] = useState('');
    const [endTime, setEndTime] = useState('');
    const [statusMessage, setStatusMessage] = useState('');
    const [isAvailable, setIsAvailable] = useState(null); // null, true, false
    const [timer, setTimer] = useState(null);
    const [reservationData, setReservationData] = useState(null); // reserved devices

    // minimum allowed date (today)
    const minDate = useMemo(() => formatDate(new Date()), []);

    // validation and button enabling
    const isCurrentDate = selectedDate === minDate;
    const currentHour = getCurrentHour();

    // only hours (without minutes) >= current hour  (if same day)
    const availableStartTimes = useMemo(() => {
        if (!selectedDate) return timeOptions;

        const currentHour = getCurrentHour();

        return timeOptions.filter(time => {
            const hour = parseInt(time.split(':')[0]);
            // if the selected day is today, start hour must be >= current hour + 1
            // if the selected day is not today, every hour is available
            return isCurrentDate ? hour > currentHour : true;
        });
    }, [selectedDate, isCurrentDate]);


    // end hour options (after start time, max 24h)
    const availableEndTimes = useMemo(() => {
        if (!startTime) return [];

        const startHour = parseInt(startTime.split(':')[0]);


        return timeOptions.filter(time => {
            const endHour = parseInt(time.split(':')[0]);

            if (endHour === startHour) return false;

            return true;
        });

    }, [startTime]);

    // check if all fiekds are selected
    const isFormValid = selectedDate && startTime && endTime;

    // Controlla se l'orario finale è logicamente valido (è dopo l'orario di inizio)
    // Non è necessario un controllo aggiuntivo qui dato che availableEndTimes lo filtra,
    // ma aggiungiamo un controllo di sicurezza per garantire che end > start.
    const isTimeSlotValid = startTime && endTime && (
        parseInt(endTime.split(':')[0]) > parseInt(startTime.split(':')[0]) ||
        parseInt(endTime.split(':')[0]) <= parseInt(startTime.split(':')[0]) // Se il giorno dopo
    );

    const isButtonEnabled = selectedDate && startTime && endTime && isAvailable === null;

    const handleCheckReservation = async () => {
        if (!isButtonEnabled) return;

        setStatusMessage("Checking availability...");
        setIsAvailable(null);
        setTimer(null);
        setReservationData(null);

        const reservationStart = `${selectedDate} ${startTime}`;
        const reservationEnd = `${selectedDate} ${endTime}`;

        // Simula i device prenotati (nel prompt non sono stati specificati)
        const devices = ['testbed-1'];

        // 2. Chiamata API (Simulata)
        // L'endpoint reale sarà /api/orchestrator/checkReservation

        // --- Simulazione della Risposta ---
        const isFree = Math.random() > 0.3; // 70% di probabilità di essere libero
        // Il controller restituirebbe lo slot di inizio
        const reservationStartTime = new Date(reservationStart).getTime();

        setTimeout(() => {
            if (isFree) {
                setStatusMessage(`Testbed available! Reservation confirmed for ${reservationStart} - ${reservationEnd}.`);
                setIsAvailable(true);
                setReservationData({ start: reservationStartTime, devices });

                // start timer
                const now = new Date().getTime();
                const initialDelay = reservationStartTime > now ? reservationStartTime - now : 0;
                setTimer(Math.max(0, Math.ceil(initialDelay / 1000))); // in seconds
            } else {
                setStatusMessage("Testbed is currently occupied. Please select a different slot.");
                setIsAvailable(false);
                setTimer(null);
            }
        }, 1500); // Ritardo simulato per la chiamata di rete
    };



    useEffect(() => {
        if (timer === null || timer <= 0) return;

        const intervalId = setInterval(() => {
            setTimer(prevTimer => {
                if (prevTimer <= 1) {
                    clearInterval(intervalId);
                    setStatusMessage(`Reservation for Testbed-1 has started! You can now proceed to the Configuration phase.`);
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
                        value={selectedDate}
                        min={minDate}
                        onChange={(e) => {
                            setSelectedDate(e.target.value);
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
                    <label htmlFor="start-time">Start Time (HH:00):</label>
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
                        disabled={!selectedDate}
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
                    <label htmlFor="end-time">End Time (HH:00) - Max 24h:</label>
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
                        {availableEndTimes.map(time => (
                            <option key={time} value={time}>{time}</option>
                        ))}
                    </select>
                </div>

                {/* submit button */}
                <button
                    className="submit-button reservation-button"
                    onClick={handleCheckReservation}
                    disabled={!isButtonEnabled}
                >
                    Check Availability & Book
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
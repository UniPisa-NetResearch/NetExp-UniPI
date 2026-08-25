import React, { useEffect, useState } from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import './style/style.css';
import './style/navbar.css';

const navItems = [
    { name: 'Home', path: '/' },
    { name: 'Reservation', path: '/reservation' },
    { name: 'Configuration', path: '/configuration' },
    { name: 'LLM Agent', path: '/llmAgent' },
    { name: 'Troubleshooter', path: '/troubleshooter' },
    { name: 'Experiment', path: '/experiment' },
    { name: 'Evaluation', path: '/evaluation' },
];

const isLinkActive = (itemPath, currentPath) => {
    if (itemPath === '/') {
        return currentPath === '/';     // on the root, only Home link must be active
    }
    return currentPath === itemPath;
};

// this component will receive teh children component to show (Home, Reservation, etc)
const NavbarLayout = ({ children, username, onLogout, showLogoutButton = true, isReservationActive = false, activeReservationExpiration = null, isAccessGranted = false, checkEvaluationAccess, reservationId }) => {
    const location = useLocation();
    const navigate = useNavigate();
    // states for the progress modal
    const [isProgressModalOpen, setIsProgressModalOpen] = useState(false);
    const [setupProgress, setSetupProgress] = useState({ status: "queued", progress: {} });
    const [waitingResId, setWaitingResId] = useState(null);

    const handleLogout = () => {
        onLogout();
        navigate('/login');
    };

    // timer display state
    const [timerDisplay, setTimerDisplay] = useState('--:--');

    useEffect(() => {
        let intervalId = null;

        const updateTimer = () => {
        if (!isReservationActive || !activeReservationExpiration) {
            setTimerDisplay('--:--');
            return;
        }

        // parse expiration
        const expires = new Date(activeReservationExpiration)

        const diffMs = expires.getTime() - Date.now();
        const diffSec = Math.max(0, Math.floor(diffMs / 1000));

        if (diffSec <= 0) {
            setTimerDisplay('--:--');
            return;
        }

        const hours = Math.floor(diffSec / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        const seconds = diffSec % 60;

        const pad = (n) => n.toString().padStart(2, '0');
        const formatted = hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
        setTimerDisplay(formatted);
        };

        // initial update
        updateTimer();

        if (isReservationActive && activeReservationExpiration) {
            intervalId = setInterval(updateTimer, 1000);
        }

        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [isReservationActive, activeReservationExpiration]);

    // clear the waiting state automatically as soon as the WebSocket grants the active token
    useEffect(() => {
        if (isReservationActive) {
            setWaitingResId(null);
        }
    }, [isReservationActive]);

    // polling effect for the setup progress modal (every 5 seconds)
    useEffect(() => {
        let intervalId = null;

        // if the modal is open but we are explicitly in the waiting state, just set the state to queued statically and do not poll the backend.
        if (isProgressModalOpen && waitingResId) {
            setSetupProgress({ status: "queued", progress: {} });
        }
        // start polling only if the modal is open, access is not yet granted, and we have a valid reservation
        else if (isProgressModalOpen && !isAccessGranted && reservationId && isReservationActive) {
            const fetchProgress = async () => {
                try {
                    const res = await fetch(`/api/controller/getSetupProgress?reservation_id=${reservationId}`);
                    if (res.ok) {
                        const data = await res.json();
                        if (data.ok) {
                            setSetupProgress(data);
                        }
                    }
                } catch (e) {
                    console.error("Error fetching setup progress", e);
                }
            };
            
            // execute immediately on open, then loop
            fetchProgress();
            intervalId = setInterval(fetchProgress, 5000);
        }

        // auto-close the modal when the main App.jsx polling detects that the access is finally granted
        if (isAccessGranted && isProgressModalOpen) {
            setIsProgressModalOpen(false);
            setWaitingResId(null);
        }

        return () => {
            if (intervalId) clearInterval(intervalId);
        };
    }, [isProgressModalOpen, isAccessGranted, reservationId, waitingResId, isReservationActive]);


    const handleNavClick = async (e, item) => {
        // block navigation to configuration if there is no active reservation/token
        if ((item.path === '/configuration' || item.path=== '/llmAgent' || item.path === '/troubleshooter' || item.path === '/experiment' || item.path === '/evaluation') && !isReservationActive) {
            e.preventDefault();

            if (item.path !== '/evaluation') {
                try {
                    const response = await fetch('/api/orchestrator/activeReservationStatus', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username })
                    });
                    const data = await response.json();
                    
                    // if the reservation is just queued (yellow), open the modal and skip the alert
                    if (data.ok && data.isWaiting) {
                        setWaitingResId(data.reservation_id);
                        setIsProgressModalOpen(true);
                        return;
                    }
                } catch (err) {
                    console.error("Error checking reservation status", err);
                }
            }

            // give feedback and remain on current page
            alert('⚠️ Access denied: you do not have an active reservation.');
            return;
        }

        if ((item.path === '/configuration' || item.path=== '/llmAgent' || item.path === '/troubleshooter' || item.path === '/experiment') && !isAccessGranted) {
            e.preventDefault();
            // open the progress modal instead of showing an alert
            setIsProgressModalOpen(true);
            return;
        }

        if (item.path === '/evaluation') {
            e.preventDefault();
            const hasAccess = await checkEvaluationAccess();

            if (!hasAccess) {
                alert('⏳ No completed experiments available for evaluation.');
                return;
            }
            
            navigate(item.path);
        }
    };

    return (
        <div className="main-wrapper">
            <nav className="navbar">
                <img src="/NetExp.png" alt="NetExp Logo" className="navbar-logo"/>

                <div className="navbar-links">
                    {navItems.map((item) => (
                            <Link
                                key={item.name}
                                to={item.path}
                                onClick={(e) => handleNavClick(e, item)}
                                className={`nav-link ${isLinkActive(item.path, location.pathname) ? 'active' : ''}`}
                            >
                                {item.name}
                            </Link>
                    ))}
                </div>

                <div className="navbar-menu">
                    <div className="active-timer">{timerDisplay}</div>
                    {/* logout button is visible only in Home page*/}
                    {showLogoutButton && (
                        <button onClick={handleLogout} className="logout-button">
                            Logout
                        </button>
                    )}
                </div>
            </nav>

            {/* dynamic content */}
            <div>
                {children}
            </div>

            {/* progress modal */}
            {isProgressModalOpen && (
                <div className="modal-overlay">
                    <div className="modal-content">
                        <div className="modal-header">
                            <h3 className="progress-modal-header">Device Setup in Progress</h3>
                            <p className="progress-modal-wait-message">Please wait while the system configures your reserved devices.</p>
                        </div>
                        
                        <div className="modal-body">
                            {setupProgress.status === "queued" ? (
                                <div className="progress-modal-res">
                                    ⏳ Waiting for the current reservation setup to start...
                                </div>
                            ) : (
                                <div className="progress-container">
                                    {Object.entries(setupProgress.progress).map(([device, percent]) => (
                                        <div key={device}>
                                            <div className="progress-element"> <strong>{device}</strong> <span>{percent}%</span> </div>
                                            <div className="progress-bar">
                                                <div 
                                                    className={`progress-bar-fill ${percent === 100 ? "completed" : "in-progress"}`} 
                                                     style={{width: `${percent}%`}}>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="modal-footer">
                            <button className="en-btn-cancel" onClick={() => setIsProgressModalOpen(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    );
};

export default NavbarLayout;
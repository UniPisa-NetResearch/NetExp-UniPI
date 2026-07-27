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
const NavbarLayout = ({ children, onLogout, showLogoutButton = true, isReservationActive = false, activeReservationExpiration = null, isAccessGranted = false, isEvaluationAccessGranted = false, checkEvaluationAccess }) => {
    const location = useLocation();
    const navigate = useNavigate();
    const [isAgentMenuOpen, setIsAgentMenuOpen] = useState(false);

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


    const handleNavClick = async (e, item) => {
        // block navigation to configuration if there is no active reservation/token
        if ((item.path === '/configuration' || item.path=== '/llmAgent' || item.path === '/troubleshooter' || item.path === '/experiment' || item.path === '/evaluation') && !isReservationActive) {
            e.preventDefault();
            // give feedback and remain on current page
            alert('⚠️ Access denied: you do not have an active reservation.');
            return;
        }

        if ((item.path === '/configuration' || item.path=== '/llmAgent' || item.path === '/troubleshooter' || item.path === '/experiment') && !isAccessGranted) {
            e.preventDefault();
            // give feedback and remain on current page
            alert('⏳ Account creation in progress on devices. Please wait before accessing this page.');
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
        </div>
    );
};

export default NavbarLayout;
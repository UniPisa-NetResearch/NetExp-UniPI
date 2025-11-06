import React from 'react';
import { useNavigate, Link, useLocation } from 'react-router-dom';
import './style/style.css';
import './style/navbar.css';

const navItems = [
    { name: 'Home', path: '/' },
    { name: 'Reservation', path: '/reservation' },
    { name: 'Configuration', path: '/configuration' },
    { name: 'Experiment', path: '/experiment' },
    { name: 'Telemetry', path: '/telemetry' },
    { name: 'Evaluation', path: '/evaluation' },
];

const isLinkActive = (itemPath, currentPath) => {
    if (itemPath === '/') {
        return currentPath === '/';     // on the root, only Home link must be active
    }
    return currentPath.startsWith(itemPath);    // for other links, check if path starts item path.
};

// this component will receive teh children component to show (Home, Reservation, etc)
const NavbarLayout = ({ children, onLogout, showLogoutButton = true }) => {
    const location = useLocation();
    const navigate = useNavigate();

    const handleLogout = () => {
        onLogout();
        navigate('/login');
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
                            className={`nav-link ${isLinkActive(item.path, location.pathname) ? 'active' : ''}`}
                        >
                            {item.name}
                        </Link>
                    ))}
                </div>

                <div className="navbar-menu">
                    <div className="active-timer">--:--</div>
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
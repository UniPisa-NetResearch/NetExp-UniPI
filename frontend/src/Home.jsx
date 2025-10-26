import React from 'react';
import { useNavigate } from 'react-router-dom';
import './style/style.css';

const Home = ({ username, onLogout }) => {
    const navigate = useNavigate();

    const handleLogout = () => {
        onLogout(); // reset the status in App.jsx (isAuthenticated=false)
        navigate('/login'); // redirect to the login page
    };

    return (
        <div className="main-wrapper">
            <nav className="navbar">
                <img src="/NetExp.png" alt="NetExp Logo" className="navbar-logo"/>
                <div className="navbar-menu">
                    <button onClick={handleLogout} className="logout-button">
                        Logout
                    </button>
                </div>
            </nav>

            <div className="container">
                <div className="card">
                    <h2 className="title">Testbed Reservation Panel 🗓️</h2>
                    <p>
                        Welcome to the main application area. This is where you will manage your experiments.
                    </p>
                    {/* Futura navigazione (Reservation, Configuration, Measurement) andrà qui. */}
                </div>
            </div>
        </div>
    );
};

export default Home;
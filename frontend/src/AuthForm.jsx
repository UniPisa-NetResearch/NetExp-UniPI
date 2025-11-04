import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import './style/style.css';
import './style/navbar.css';

const AuthForm = ({ onAuthSuccess }) => {
    const navigate = useNavigate();
    const [isLogin, setIsLogin] = useState(true);
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [sshKey, setSshKey] = useState('');

    const [message, setMessage] = useState('');

    const handleSubmit = async (e) => {
        e.preventDefault();
        // if the user presses 'Login'
        setMessage(''); // reset previous message
        const url = isLogin ? '/api/auth/login' : '/api/auth/signup';

        const payload = isLogin
            ? {username, password}
            : {username, password, sshKey};

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
            });

            const data = await response.json();

            if (response.ok) {
                // Success
                setMessage(`Success: ${data.message}`);

                onAuthSuccess(username); // update status in App.jsx
                navigate('/');          // redirect to the Home (URL '/')
                setUsername('');
                setPassword('');
                setSshKey('');

            } else {
                setMessage(`Error: ${data.message}`);
            }
        } catch (error) {
            console.error('Fetch error:', error);
            setMessage('Connection error to Flask server');
        }
    };
    const handleToggle = (isLoginMode) => {
        setIsLogin(isLoginMode);
        setMessage(''); // Resetta il messaggio all'utente
    };
    return (
        <div className="main-wrapper"> {/* wrapper for navbar and container */}
            <nav className="navbar">
                <img src="/NetExp.png" alt="NetExp Logo" className="navbar-logo"/>
            </nav>
            <div className="container">
                <div className="card">

                    <h2 className="title">
                        {isLogin ? 'Access the Testbed' : 'Register and Reserve'}
                    </h2>

                    {/* Visualizza i messaggi di stato/errore */}
                    {message && (
                        <p style={{ color: message.startsWith('Error') ? 'red' : 'green', marginBottom: '15px' }}>
                            {message}
                        </p>
                    )}

                    <div className="toggle-group">
                        <button
                            onClick={() => handleToggle(true)}
                            className={`toggle-button ${isLogin ? 'active' : ''}`}
                        >
                            Login
                        </button>
                        <button
                            onClick={() => handleToggle(false)}
                            className={`toggle-button ${!isLogin ? 'active' : ''}`}
                        >
                            Signup
                        </button>
                    </div>
                    {/* Form */}
                    <form onSubmit={handleSubmit}>
                        <input type="text" placeholder="Username" value={username}
                               onChange={(e) => setUsername(e.target.value)} required className="input-field"/>
                        <input type="password" placeholder="Password" value={password}
                               onChange={(e) => setPassword(e.target.value)} required className="input-field"/>
                        {!isLogin && (
                            <textarea placeholder="SSH Public Key" value={sshKey}
                                      onChange={(e) => setSshKey(e.target.value)} required rows="4"
                                      className="input-field textarea-field"/>
                        )}
                        <button type="submit" className="submit-button">
                            {isLogin ? 'Log In' : 'Sign Up'}
                        </button>
                    </form>
                </div>
                <p className="footer-text">Reservation System for Experiment Testbed</p>
            </div>
        </div>
    );
};

export default AuthForm; // component export
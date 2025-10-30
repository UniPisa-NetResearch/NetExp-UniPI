import React, { useState, useEffect } from 'react';
import './style/style.css';

const UserKeyManager = ({ initialUsername }) => {
    const [currentKey, setCurrentKey] = useState('Loading...');
    const [newKey, setNewKey] = useState('');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);

    // fetch user data on page load
    useEffect(() => {
        const fetchUserData = async () => {
            try {
                const response = await fetch('/api/auth/user/show_user', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: initialUsername }),
                });

                if (response.ok) {
                    const data = await response.json();
                    setCurrentKey(data.ssh_key);
                } else {
                    setMessage(`Error: Failed to fetch user data.`);
                    setCurrentKey('Key retrieval failed.');
                }
            } catch (error) {
                setMessage('Connection error to server.');
                setCurrentKey('Connection error.');
            } finally {
                setLoading(false);
            }
        };

        if (initialUsername) {
            fetchUserData();
        }
    }, [initialUsername]);

    // key substitution handler
    const handleKeyUpdate = async (e) => {
        e.preventDefault();
        setMessage('');

        if (newKey.length < 50 || newKey === currentKey) {
            setMessage('Error: Key is too short or unchanged.');
            return;
        }

        try {
            const response = await fetch('/api/auth/user/change_key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: initialUsername, newSshKey: newKey }),
            });

            const data = await response.json();

            if (response.ok) {
                setMessage(`Success: ${data.message}`);
                setCurrentKey(newKey);
                setNewKey('');
            } else {
                setMessage(`Error: ${data.message || 'Failed to update key.'}`);
            }
        } catch (error) {
            setMessage('Connection error to Flask server.');
        }
    };

    return (
        <div className="card key-manager-card">
            <div className="profile-header">
                <img
                    src="/userIcon.png"
                    alt="User Profile Icon"
                    className="profile-icon"
                />
                <h2 className="title">User Profile & SSH Key Management</h2>
            </div>

            <p className="user-info"><strong>Username:</strong> {initialUsername}</p>

            {loading ? (
                <p>Loading key...</p>
            ) : (
                <>
                    <h4>Current Public Key:</h4>
                    <textarea
                        value={currentKey}
                        readOnly
                        rows="4"
                        className="input-field textarea-field current-key"
                    />
                </>
            )}

            <form onSubmit={handleKeyUpdate}>
                <h4>Update SSH Key:</h4>
                <textarea
                    placeholder="Paste new SSH Public Key here..."
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value.trim())}    //remove spaces before and after
                    rows="4"
                    className="input-field textarea-field"
                    required
                />
                <button type="submit" className="submit-button update-button">Change Key</button>
            </form>

            {message && (
                <p style={{ color: message.startsWith('Error') ? 'red' : 'green', marginTop: '15px' }}>
                    {message}
                </p>
            )}
        </div>
    );
};

const Home = ({ username}) => {

    return (
        <div className="container home-content">
            <UserKeyManager initialUsername={username} />
        </div>
    );
};

export default Home;
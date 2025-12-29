import React, { useState, useEffect } from 'react';
import './style/style.css';
import './style/home.css';

const Pagination = ({ currentPage, totalPages, onPageChange }) => {
    if (totalPages <= 1) return null;

    return (
        <div className="pagination-controls">
            <button
                onClick={() => onPageChange(Math.max(0, currentPage - 1))}
                disabled={currentPage === 0}
                className="pagination-btn"
            >
                Previous
            </button>
            <span className="pagination-info">
                Page {currentPage + 1} of {totalPages}
            </span>
            <button
                onClick={() => onPageChange(Math.min(totalPages - 1, currentPage + 1))}
                disabled={currentPage === totalPages - 1}
                className="pagination-btn"
            >
                Next
            </button>
        </div>
    );
};

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

const AdminUserManager = ({ currentUserId, onUserDeleted }) => {
    const [users, setUsers] = useState([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);
    const usersPerPage = 10;

    // Fetch all users
    const fetchUsers = async () => {
        try {
            const response = await fetch('/api/auth/admin/get_all_users');
            if (response.ok) {
                const data = await response.json();
                setUsers(data.users);
            } else {
                setMessage('Error: Failed to fetch users');
            }
        } catch (error) {
            setMessage('Connection error to server');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchUsers();
    }, []);

    // Delete user
    const handleDeleteUser = async (userId, username) => {
        if (!window.confirm(`Are you sure you want to delete user "${username}"? All their reservations will also be deleted`)) {
            return;
        }

        try {
            const response = await fetch('/api/auth/admin/delete_user', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ user_id: userId }),
            });

            const data = await response.json();

            if (response.ok) {
                setMessage(`Success: ${data.message}`);
                await fetchUsers(); // Refresh list
                onUserDeleted && onUserDeleted();   // trigger refresh of reservations
            } else {
                setMessage(`Error: ${data.message}`);
            }
        } catch (error) {
            setMessage('Connection error to server');
        }
    };

    // Toggle user permissions
    const handleTogglePermission = async (userId, field, currentValue) => {
        const isSelf = userId === currentUserId;

        // Prevent admin from changing their own is_admin status
        if (isSelf && field === 'is_admin') {
            setMessage('Error: Cannot modify your own admin status');
            return;
        }

        try {
            const updateData = {
                user_id: userId,
                current_user_id: currentUserId,
                [field]: !currentValue
            };

            const response = await fetch('/api/auth/admin/update_user', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(updateData),
            });

            const data = await response.json();

            if (response.ok) {
                setMessage(`Success: ${data.message}`);
                await fetchUsers(); // Refresh list
            } else {
                setMessage(`Error: ${data.message}`);
            }
        } catch (error) {
            setMessage('Connection error to server');
        }
    };

    // Pagination logic
    const totalPages = Math.ceil(users.length / usersPerPage);
    const startIndex = currentPage * usersPerPage;
    const currentUsers = users.slice(startIndex, startIndex + usersPerPage);

    return (
        <div className="card admin-manager-card">
            <h2 className="title">Admin Panel - User Management</h2>

            {message && (
                <p style={{ color: message.startsWith('Error') ? 'red' : 'green', marginBottom: '15px' }}>
                    {message}
                </p>
            )}

            {loading ? (
                <p>Loading users...</p>
            ) : (
                <>
                    <div className="admin-table-container">
                        <table className="admin-table">
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>Username</th>
                                    <th>Full User</th>
                                    <th>Admin</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {currentUsers.map((user) => {
                                    const isSelf = user.id === currentUserId;
                                    return (
                                        <tr key={user.id}>
                                            <td>{user.id}</td>
                                            <td>{user.username}{isSelf && ' (You)'}</td>
                                            <td>
                                                <button
                                                    onClick={() => handleTogglePermission(user.id, 'full_user', user.full_user)}
                                                    className={`toggle-btn ${user.full_user ? 'active' : 'inactive'}`}
                                                >
                                                    {user.full_user ? 'Yes' : 'No'}
                                                </button>
                                            </td>
                                            <td>
                                                <button
                                                    onClick={() => handleTogglePermission(user.id, 'is_admin', user.is_admin)}
                                                    className={`toggle-btn ${user.is_admin ? 'active' : 'inactive'}`}
                                                    disabled={isSelf}
                                                    style={{ opacity: isSelf ? 0.5 : 1, cursor: isSelf ? 'not-allowed' : 'pointer' }}
                                                >
                                                    {user.is_admin ? 'Yes' : 'No'}
                                                </button>
                                            </td>
                                            <td>
                                                <button
                                                    onClick={() => handleDeleteUser(user.id, user.username)}
                                                    className="delete-btn"
                                                    disabled={isSelf}
                                                    style={{ opacity: isSelf ? 0.5 : 1, cursor: isSelf ? 'not-allowed' : 'pointer' }}
                                                >
                                                    Delete
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination controls */}
                     <Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={setCurrentPage}
                    />
                </>
            )}
        </div>
    );
};

const AdminReservationManager = () => {
    const [reservations, setReservations] = useState([]);
    const [currentPage, setCurrentPage] = useState(0);
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);
    const reservationsPerPage = 10;

    const fetchReservations = async () => {
        try {
            const response = await fetch('/api/auth/admin/get_all_reservations');
            if (response.ok) {
                const data = await response.json();
                setReservations(data.reservations);
            } else {
                setMessage('Error: Failed to fetch reservations');
            }
        } catch (error) {
            setMessage('Connection error to server');
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchReservations();
    }, []);

    const handleDeleteReservation = async (reservationId, username) => {
        if (!window.confirm(`Are you sure you want to delete reservation #${reservationId}?`)) {
            return;
        }

        try {
            const response = await fetch('/api/auth/admin/delete_reservation', {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id: reservationId }),
            });

            const data = await response.json();

            if (response.ok) {
                // call the cleanup of in memory and file reservation active status
                try {
                    const cleanupResponse = await fetch('http://localhost:5002/api/controller/cleanupReservation', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            reservation_id: reservationId,
                            username: username
                        }),
                    });

                    if (!cleanupResponse.ok) {
                        console.warn(`Cleanup failed for reservation ${reservationId}`);
                    }
                } catch (cleanupError) {
                    console.error('Error calling controller cleanup:', cleanupError);
                }
                setMessage(`Success: ${data.message}`);
                await fetchReservations();
            } else {
                setMessage(`Error: ${data.message}`);
            }
        } catch (error) {
            setMessage('Connection error to server');
        }
    };

    const totalPages = Math.ceil(reservations.length / reservationsPerPage);
    const startIndex = currentPage * reservationsPerPage;
    const currentReservations = reservations.slice(startIndex, startIndex + reservationsPerPage);

    return (
        <div className="card admin-manager-card">
            <h2 className="title">Admin Panel - Reservation Management</h2>

            {message && (
                <p style={{ color: message.startsWith('Error') ? 'red' : 'green', marginBottom: '15px' }}>
                    {message}
                </p>
            )}

            {loading ? (
                <p>Loading reservations...</p>
            ) : (
                <>
                    <div className="admin-table-container">
                        <table className="admin-table">
                            <thead>
                                <tr>
                                    <th>ID</th>
                                    <th>Username</th>
                                    <th>Start</th>
                                    <th>End</th>
                                    <th>Token</th>
                                    <th>Devices</th>
                                    <th>Actions</th>
                                </tr>
                            </thead>
                            <tbody>
                                {currentReservations.map((res) => (
                                    <tr key={res.id}>
                                        <td>{res.id}</td>
                                        <td>{res.username}</td>
                                        <td>
                                            {res.start_date} {res.start_time}
                                        </td>
                                        <td>
                                            {res.end_date} {res.end_time}
                                        </td>
                                        <td>
                                            <span className={`token-badge ${res.has_token ? 'present' : 'absent'}`}>
                                                {res.has_token ? 'Present' : 'Absent'}
                                            </span>
                                        </td>
                                        <td>
                                            <div className="device-list">
                                                {res.devices.length > 0 ? res.devices.join(', ') : 'None'}
                                            </div>
                                        </td>
                                        <td>
                                            <button
                                                onClick={() => handleDeleteReservation(res.id, res.username)}
                                                className="delete-btn"
                                            >
                                                Delete
                                            </button>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>

                     <Pagination
                        currentPage={currentPage}
                        totalPages={totalPages}
                        onPageChange={setCurrentPage}
                    />
                </>
            )}
        </div>
    );
};

const Home = ({ username, isAdmin, userId}) => {
    const [refreshTrigger, setRefreshTrigger] = useState(0);

    return (
        <div className="container home-content">
            <UserKeyManager initialUsername={username} />
            {isAdmin && <AdminUserManager currentUserId={userId}  onUserDeleted={() => setRefreshTrigger(prev => prev + 1)}/>}
            {isAdmin && <AdminReservationManager key={refreshTrigger}/>}
        </div>
    );
};

export default Home;
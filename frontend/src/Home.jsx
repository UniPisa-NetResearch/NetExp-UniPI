import React, { useState, useEffect, useRef } from 'react';
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

const UserKeyManager = ({ initialUsername, isProcessing, setIsProcessing }) => {
    const [currentKey, setCurrentKey] = useState('Loading...');
    const [newKey, setNewKey] = useState('');
    const [message, setMessage] = useState('');
    const [loading, setLoading] = useState(true);

    // fetch user data on page load
    useEffect(() => {
        const fetchUserData = async () => {
            try {
                const response = await fetch('/api/auth/user/showUser', {
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

        const trimmedNewKey = newKey.trim();
        const trimmedCurrentKey = currentKey.trim();

        if (trimmedNewKey.length < 50 || trimmedNewKey === trimmedCurrentKey) {
            setMessage('Error: Key is too short or unchanged.');
            return; // Esce senza bloccare il pulsante
        }

        setIsProcessing(true);

        try {
            const response = await fetch('/api/auth/user/changeKey', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: initialUsername, newSshKey: trimmedNewKey }),
            });

            const data = await response.json();

            if (response.ok) {
                setMessage(`Success: ${data.message}`);
                setCurrentKey(trimmedNewKey);
                setNewKey('');
            } else {
                setMessage(`Error: ${data.message || 'Failed to update key.'}`);
            }
        } catch (error) {
            setMessage('Connection error to Flask server.');
        } finally{
            setIsProcessing(false);
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
                    onChange={(e) => {setNewKey(e.target.value.trim()); if (message) setMessage('');}}    //remove spaces before and after
                    rows="4"
                    className="input-field textarea-field"
                    disabled={isProcessing}
                    required
                />
                <button type="submit" className="submit-button update-button" disabled={isProcessing || loading}>Change Key</button>
            </form>

            {message && (
                <p style={{ color: message.startsWith('Error') ? 'red' : 'green', marginTop: '15px' }}>
                    {message}
                </p>
            )}
        </div>
    );
};

const UserFilesManager = ({ username, isProcessing, setIsProcessing }) => {
  const [files, setFiles] = useState([]);
  const [stats, setStats] = useState({ total_bytes: 0, quota_bytes: 0, usage_percent: 0 });
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [selectedRes, setSelectedRes] = useState('all');
  const [folderType, setFolderType] = useState('all');
  // extract list of unique reservations from loaded files
  const availableReservations = [...new Set(files.map(f => f.path.split('/')[0]))];
  const [currentPage, setCurrentPage] = useState(0);
  const filesPerPage = 10;

  useEffect(() => {
      setCurrentPage(0);
  }, [selectedRes, folderType]);

  const filteredFiles = files.filter(file => {
      const parts = file.path.split('/');
      const resMatch = selectedRes === 'all' || parts[0] === selectedRes;

      // filter for folder type (experimentResults or devices)
      const typeMatch = folderType === 'all' || file.path.includes(`/${folderType}/`);

      return resMatch && typeMatch;
  });

  const totalPages = Math.ceil(filteredFiles.length / filesPerPage);
  const startIndex = currentPage * filesPerPage;
  const currentFiles = filteredFiles.slice(startIndex, startIndex + filesPerPage);

  const getSelectedPaths = () => {
      if (selectedRes !== 'all') {
          return folderType === 'all' ? [selectedRes] : [`${selectedRes}/${folderType}`];
      }
      // 'all' reservations
      return availableReservations.map(res =>
          folderType === 'all' ? res : `${res}/${folderType}`
      );
  };

  // format bytes in readable format
  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  };

  // load file list
  const loadFiles = async () => {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch('/api/controller/user/listFiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username })
      });

      const data = await response.json();

      if (response.ok && data.ok) {
        setFiles(data.files || []);
        setStats({
          total_bytes: data.total_bytes,
          quota_bytes: data.quota_bytes,
          usage_percent: data.usage_percent
        });
        if(data.message){
            setMessage(data.message);
        }
      } else {
        setMessage(`Error: ${data.message || 'Failed to load files'}`);
      }
    } catch (error) {
      setMessage("Connection error to server.");
    } finally {
      setLoading(false);
    }
  };

  // download file
  const handleDownload = async (filePath) => {
      // check if it is single file or multiple files
      const isMultiple = Array.isArray(filePath);
      const paths = isMultiple ? filePath : [filePath];
      setIsProcessing(true);
      setMessage("Preparing download, please wait...");
      try {
          const response = await fetch('/api/controller/user/downloadFile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username, file_paths: paths })
          });

          if (response.ok) {
              const blob = await response.blob();
              const url = window.URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              if (!isMultiple) {
                  const fileName = filePath.split('/').pop();
                  a.download = `${fileName}.zip`;
              } else {
                  a.download = `nas_storage_export.zip`;
              }

              document.body.appendChild(a);
              a.click();
              a.remove();
              window.URL.revokeObjectURL(url);
              setMessage(isMultiple ? "Success: Folder download started" : `Success: Downloaded ${filePath.split('/').pop()}`);
          } else {
              const data = await response.json();
              setMessage(`Error: ${data.message || 'Download failed'}`);
          }
      } catch (error) {
          setMessage("Connection error during download.");
      } finally {
          setIsProcessing(false);
      }
  };

  // delete file
  const handleDelete = async (filePath) => {
      const paths = Array.isArray(filePath) ? filePath : [filePath];
      if (paths.length === 0) return;
      if (!window.confirm(`Are you sure you want to delete ${paths.length} item(s)?`)) {
          return;
      }

      setIsProcessing(true);
      setMessage("Deleting files, please wait...");

      try {
          const response = await fetch('/api/controller/user/deleteFile', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: username, file_paths: paths })
          });

          const data = await response.json();

          if (response.ok && data.ok) {
              setFiles(prevFiles => prevFiles.filter(file => {
                  return !paths.some(p => file.path === p || file.path.startsWith(p + '/'));
              }));
              setMessage(`Success: ${data.message}`);

              if (selectedRes === 'all' && folderType === 'all') {
                  setFiles([]);
              }

              await loadFiles();
          } else {
              setMessage(`Error: ${data.message || 'Delete failed'}`);
          }
      } catch (error) {
          setMessage("Connection error during delete.");
      } finally {
          setIsProcessing(false);
      }
  };

  useEffect(() => {
    if (username) {
      loadFiles();
    }
  }, [username]);

  return (
      <div className="card file-manager-card">
          <div className="profile-header">
              <h2 className="title">📁 Storage Files Management</h2>
          </div>
          {loading ? (
              <div className="loading-container">
                  <p>Loading storage files...</p>
              </div>
          ) : (
              <>
                  {/* space usage bar */}
                  <div className="space-usage-bar">
                      <p><strong>Storage
                          Usage:</strong> {formatBytes(stats.total_bytes)} / {formatBytes(stats.quota_bytes)} ({stats.usage_percent.toFixed(2)}%)
                      </p>
                      <div className="complete-bar">
                          <div className={`percentage-usage-bar ${stats.usage_percent > 90 ? 'full' : stats.usage_percent > 70 ? 'almost-full' : 'free'}`} style={{width: `${Math.min(stats.usage_percent, 100)}%`,}}/>
                      </div>
                  </div>
                  <div className="file-filters">
                      <span className="filter-label">Select reservation:</span>
                      <select className="filter-select" value={selectedRes} disabled={isProcessing}
                              onChange={(e) => setSelectedRes(e.target.value)}>
                          <option value="all">All Reservations</option>
                          {availableReservations.map(res => (<option key={res} value={res}>{res}</option>))}
                      </select>
                      <span className="filter-label">Select folder:</span>
                      <select className="filter-select" value={folderType} disabled={isProcessing}
                              onChange={(e) => setFolderType(e.target.value)}>
                          <option value="all">All Folders</option>
                          <option value="experimentResults">Experiment Results</option>
                          <option value="devices">Devices</option>
                      </select>
                      <span className="filter-label">Download selected files:</span>
                      <button onClick={() => {
                          const paths = getSelectedPaths();
                          handleDownload(paths)
                      }} className="submit-button download-file-button download-zip-button"
                              disabled={isProcessing || files.length === 0}>Download Zip
                      </button>
                      <span className="filter-label">Delete selected files:</span>
                      <button onClick={() => {
                          const paths = getSelectedPaths();
                          handleDelete(paths)
                      }} className="delete-btn delete-file-button multi-delete-button"
                              disabled={isProcessing || files.length === 0}>Delete Files
                      </button>
                  </div>

                  {message && (<p className={`file-section-message ${message.startsWith('Error') ? 'error' : message.includes('wait') ? 'wait' : message.includes('No') ? 'no-file' : 'success'}`}>{message}</p>)}

                  {files.length > 0 && (
                      <>
                          <div className="file-table-container">
                              <table className="admin-table file-table">
                                  <thead>
                                  <tr>
                                      <th>File Path</th>
                                      <th>Size</th>
                                      <th>Modified</th>
                                      <th>Actions</th>
                                  </tr>
                                  </thead>

                                  <tbody>
                                  {currentFiles.map((file, index) => {
                                      // create the name to visualize
                                      let displayPath = file.path;
                                      // if a reservation is selected, remove "res_X/"
                                      if (selectedRes !== 'all') {
                                          displayPath = displayPath.replace(`${selectedRes}/`, '');
                                      }

                                      // if a type of folder is selected, we remove it
                                      if (folderType !== 'all') {
                                          displayPath = displayPath.replace(`${folderType}/`, '');
                                      }

                                      return (
                                          <tr key={index}>
                                              <td className="truncate-text" title={file.path}>{displayPath}</td>
                                              <td>{formatBytes(file.size_bytes)}</td>
                                              <td>{file.modified}</td>
                                              <td className="file-actions-cell">
                                                  <button onClick={() => handleDownload(file.path)} className="submit-button download-file-button" disabled={isProcessing}>Download</button>
                                                  <button onClick={() => handleDelete(file.path)} className="delete-btn delete-file-button" disabled={isProcessing}>Delete</button>
                                              </td>
                                          </tr>
                                      );
                                  })}
                                  </tbody>
                              </table>
                          </div>
                        <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage}/>
                      </>
                  )}
              </>
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
            const response = await fetch('/api/auth/admin/getAllUsers');
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
            // check if the user has an active reservation
            const checkResponse = await fetch('/api/auth/admin/getAllReservations');

            if (checkResponse.ok) {
                const reservationsData = await checkResponse.json();
                const userActiveReservation = reservationsData.reservations.find(
                    res => res.username === username && res.has_token
                );

                if (userActiveReservation) {
                    setMessage(`Error: Cannot delete user "${username}" - user has an active reservation (ID: ${userActiveReservation.id})`);
                    return;
                }
            }

            const response = await fetch('/api/auth/admin/deleteUser', {
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

            const response = await fetch('/api/auth/admin/updateUser', {
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
    const [rollbackStates, setRollbackStates] = useState({});
    const [deletingWithRollback, setDeletingWithRollback] = useState(false);    // waiting message for rollback
    const reservationsPerPage = 10;

    const fetchReservations = async () => {
        try {
            const response = await fetch('/api/auth/admin/getAllReservations');
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

    const handleToggleRollback = (reservationId) => {
        setRollbackStates(prev => ({
            ...prev,
            [reservationId]: !prev[reservationId]
        }));
    };


    const handleDeleteReservation = async (reservationId, username, hasToken) => {
        if (!window.confirm(`Are you sure you want to delete reservation #${reservationId}?`)) {
            return;
        }

        try {
            // if the reservation does not have the token, remove and clean only reservation info in memory and file
            if (!hasToken) {
                const response = await fetch('/api/auth/admin/deleteReservation', {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reservation_id: reservationId }),
                });

                const data = await response.json();

                if (response.ok) {
                    // call the cleanup of in memory and file reservation active status
                    try {
                        const cleanupResponse = await fetch('/api/controller/cleanupReservation', {
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
            } else{
                // if there is token, call revoke_access
                const rollback = rollbackStates[reservationId] || false;

                // wait message for rollback
                if (rollback) {
                    setDeletingWithRollback(true);
                    setMessage('Deleting reservation with rollback... This may take a few minutes.');
                } else {
                    setMessage('Deleting reservation without rollback...');
                }
                // get ssh_key from the user
                const userResponse = await fetch('/api/auth/user/showUser', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username: username }),
                });

                if (!userResponse.ok) {
                    setDeletingWithRollback(false);
                    setMessage('Error: Failed to retrieve user SSH key');
                    return;
                }

                const userData = await userResponse.json();
                const sshKey = userData.ssh_key;

                // call revoke_access
                const revokeResponse = await fetch('/api/controller/revokeAccess', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        reservation_id: reservationId,
                        username: username,
                        ssh_key: sshKey,
                        rollback: rollback
                    }),
                });

                const revokeData = await revokeResponse.json();

                if (revokeResponse.ok) {
                    // Dopo revoke con successo, elimina dal database
                    const deleteResponse = await fetch('/api/auth/admin/deleteReservation', {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ reservation_id: reservationId }),
                    });

                    if (deleteResponse.ok) {
                        setMessage(`Success: Reservation deleted ${rollback ? 'with rollback' : 'without rollback'}`);
                        await fetchReservations();
                    } else {
                        setMessage('Error: Revoke succeeded but database deletion failed');
                    }
                } else {
                    setMessage(`Error: ${revokeData.message || 'Failed to revoke access'}`);
                }
                setDeletingWithRollback(false);
            }
        } catch (error) {
            setDeletingWithRollback(false);
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
                <p style={{ color: message.startsWith('Error') ? 'red' : message.startsWith('Deleting') ? 'orange' :'green', marginBottom: '15px',  fontWeight: deletingWithRollback ? 'bold' : 'normal' }}>
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
                                    <th>Rollback</th>
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
                                            <button
                                                onClick={() => handleToggleRollback(res.id)}
                                                className={`toggle-btn ${rollbackStates[res.id] ? 'active' : 'inactive'}`}
                                                disabled={!res.has_token}
                                                style={{
                                                    opacity: !res.has_token ? 0.5 : 1,
                                                    cursor: !res.has_token ? 'not-allowed' : 'pointer'
                                                }}
                                            >
                                                {rollbackStates[res.id] ? 'Yes' : 'No'}
                                            </button>
                                        </td>
                                        <td>
                                            <div className="device-list">
                                                {res.devices.length > 0 ? res.devices.join(', ') : 'None'}
                                            </div>
                                        </td>
                                        <td>
                                            <button
                                                onClick={() => handleDeleteReservation(res.id, res.username, res.has_token)}
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

const AdminContainerlabManager = () => {
    const [output, setOutput] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    // reference applied to the scrollable container
    const terminalContainerRef = useRef(null);

    // auto-scrollthe terminal container to the bottom
    useEffect(() => {
        if (terminalContainerRef.current) {
            terminalContainerRef.current.scrollTop = terminalContainerRef.current.scrollHeight;
        }
    }, [output]);

    const handleRedeploy = async () => {
        if (!window.confirm("Are you sure you want to destroy and redeploy Containerlab deployment?")) {
            return;
        }

        setIsProcessing(true);
        setOutput('');

        try {
            // fetch request to the streaming endpoint
            const response = await fetch('/api/auth/admin/redeployContainerlab', {
                method: 'GET'
            });

            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

            // get the stream reader directly from the response body
            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');

            // read the stream chunk by chunk in real-time
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;

                // decode the Uint8Array chunk into a string and append it
                let chunk = decoder.decode(value, { stream: true });
                // regex to strip ANSI escape sequences (terminal color codes)
                chunk = chunk.replace(/\x1B\[\d*(;\d+)*[a-zA-Z]/g, '');
                // remove terminal query codes (OSC) like ESC]10;?ESC\
                chunk = chunk.replace(/\x1B\]\d+;\?[^\x1B]*\x1B\\/g, '');
                // append the clean chunk to the state
                setOutput(prev => prev + chunk);
            }
        } catch (error) {
            setOutput(prev => prev + `\n[CONNECTION ERROR] ${error.message}\n`);
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <div className="card admin-manager-card containerlab-manager-card">
            <h2 className="title">Admin Panel - Containerlab Redeployment</h2>
            <div className="containerlab-action-row">
                <p>Destroy and recreate the virtual testbed on the Containerlab device:</p>
                
                <button 
                    onClick={handleRedeploy} 
                    className="submit-button delete-btn containerlab-manager-button" 
                    disabled={isProcessing}
                >
                    {isProcessing ? 'Processing...' : 'Destroy & Deploy Containerlab'}
                </button>
            </div>

            <div className="terminal-output-container" ref={terminalContainerRef}>
                <pre className="terminal-output">
                    {output || 'Press the button to execute deplyment...'}
                </pre>
            </div>
        </div>
    );
};

const Home = ({username, isAdmin, userId}) => {
    const [refreshTrigger, setRefreshTrigger] = useState(0);
    const [isProcessing, setIsProcessing] = useState(false);

    return (
        <div className="container home-content">
            <UserKeyManager initialUsername={username} isProcessing={isProcessing} setIsProcessing={setIsProcessing}/>
            <UserFilesManager username={username} isProcessing={isProcessing} setIsProcessing={setIsProcessing}/>
            {isAdmin && <AdminUserManager currentUserId={userId}  onUserDeleted={() => setRefreshTrigger(prev => prev + 1)}/>}
            {isAdmin && <AdminReservationManager key={refreshTrigger}/>}
            {isAdmin && <AdminContainerlabManager />}
        </div>
    );
};

export default Home;
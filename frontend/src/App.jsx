import React, { useState, useEffect, useRef, useCallback} from 'react';
import { Routes, Route, Navigate, Outlet, useNavigate } from 'react-router-dom'; // router components
import { io } from 'socket.io-client';
import AuthForm from './AuthForm.jsx';
import NavbarLayout from './NavbarLayout.jsx';
import Home from './Home.jsx';
import Reservation from './Reservation.jsx';
import Configuration from './Configuration.jsx';
import Experiment from "./Experiment.jsx";
import Evaluation from "./Evaluation.jsx";

const ProtectedPageGuard = ({ isReservationActive, isAccessGranted, children }) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isReservationActive || !isAccessGranted) {
        // go back in the chronology
        // if chronology miss, go back to home
        if (window.history.length > 1) {
            navigate(-1);
        } else {
            navigate('/', { replace: true });
        }
    }
  }, [isReservationActive, isAccessGranted, navigate]);

  if (!isReservationActive || !isAccessGranted) {
    return null;
  }
  return children;
};

//Component to protect the routes
const ProtectedRoute = ({ isAuthenticated}) => {
    if (!isAuthenticated) {
        // if the user is not authenticated, redirect to /login
        return <Navigate to="/login" replace />;
    }
    // otherwise shows the content of nested route
    return <Outlet />;
};

function App() {
  // state to trace authentication and username
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);
    const [currentUserId, setCurrentUserId] = useState(null);
    const [isAdmin, setIsAdmin] = useState(false);
    const [reservationId, setReservationId] = useState(null);

    // tracks if a reservation is active (token granted) to show the timer
    const [isReservationActive, setIsReservationActive] = useState(false);
    // stores the expiration time for the active reservation
    const [activeReservationExpiration, setActiveReservationExpiration] = useState(null);
    // there is a small period in minute needed to create user accounts and install packages on devices
    // the user must wait this period to access configuration and experiment pages
    const [isAccessGranted, setIsAccessGranted] = useState(false);
    // the access of evaluation page is allowed only after experiment
    const [isEvaluationAccessGranted, setIsEvaluationAccessGranted] = useState(false);

    const socketRef = useRef(/** @type {any} */ (null));

    // check the active reservation status on the backend
    const checkActiveReservation = useCallback(async (username) => {
        if (!username) return;

        try {
            const response = await fetch(`/api/orchestrator/activeReservationStatus`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ username: username }),
            });

            const data = await response.json();

            if (data.ok) {
                // set timer status if actively reserved
                if (data.isActive) {
                    setIsReservationActive(true);
                    setReservationId(data.reservation_id)
                    setActiveReservationExpiration(data.expires_at);
                } else {
                    setIsReservationActive(false);
                    setReservationId(null)
                    setActiveReservationExpiration(null);
                    setIsAccessGranted(false);
                }
            } else {
                console.error("Error checking reservation status: ", data.message);
                setIsReservationActive(false);
                setActiveReservationExpiration(null);
            }
        } catch (error) {
            console.error("API call failed to check reservation status: ", error);
            setIsReservationActive(false);
            setActiveReservationExpiration(null);
            setIsAccessGranted(false);
        }
    }, []);

    // check device availability after user account creation for reservation

    const fetchAvailabilityStatus = useCallback(async (username, reservationId) => {
        if (!username || !reservationId) return 'error';
        try {
            const response = await fetch(`/api/controller/checkAvailability?username=${username}&reservation_id=${reservationId}`);

            if (!response.ok) {
              console.error(`HTTP error! status: ${response.status}`);
              return 'error';
            }

            const data = await response.json();

            if (data.command === 'start_configuration') {
              return 'start_configuration';
            } else if (data.command === 'wait_configuration') {
              return 'wait_configuration';
            } else {
              console.error('Unexpected API response:', data);
              return 'error';
            }

        } catch (error) {
            console.error('Error during checkAvailability call:', error);
            return 'error';
        }

    }, []);


    // set authentication and username after success
    const handleLoginSuccess = (userData) => {
        setIsAuthenticated(true);
        setCurrentUser(userData.username);
        setCurrentUserId(userData.user_id);
        setIsAdmin(userData.is_admin);
        checkActiveReservation(userData.username);
    };

    // logout function
    const handleLogout = () => {
        setIsAuthenticated(false);
        setCurrentUser(null);
        setCurrentUserId(null);
        setIsAdmin(false);
        // reset all reservation states on logout
        setIsReservationActive(false);
        setActiveReservationExpiration(null);
        setIsAccessGranted(false);

         if (socketRef.current) {
          socketRef.current.emit('logout', { user_id: currentUserId });
          socketRef.current.disconnect();
          socketRef.current = null;
        }
    }

    // reservation event handler
    const handleReservationEvent = useCallback((payload) => {
        // payload.type == 'granted' | 'revoked'
        console.log("[socket] reservation_event: ", payload);

        if (payload.type === "granted") {
            // event granted: start timer and permit access
            setIsReservationActive(true);
            setActiveReservationExpiration(payload.expires_at);
            setReservationId(payload.reservation_id);
            setIsAccessGranted(false);
        } else if (payload.type === "revoked") {
            // event revoked: stop timer and block access
            setIsReservationActive(false);
            setActiveReservationExpiration(null);
            setIsAccessGranted(false);
        }
    }, []);

    useEffect(() => {

        if (!isAuthenticated || !currentUser || !currentUserId) return;

        const serverUrl = "http://localhost:5001"; // orchestrator socket server

        // create socket and connect
        const socket = io(serverUrl, {
          transports: ["websocket"],
          autoConnect: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000
        });
        socketRef.current = socket;

        socket.on("connect", () => {
          console.log("[socket] connected: ", socket.id);
          socket.emit("identify", /** @type {any} */ ({ user_id: currentUserId, username: currentUser }));
        });

        socket.on("connected", (msg) => {
          console.log("[socket] server acknowledged connect: ", msg);
        });

        socket.on("identify_ack", (ack) => {
          console.log("[socket] identify_ack: ", ack);
        });

        socket.on("reservation_event", handleReservationEvent);

        socket.on("disconnect", (reason) => {
          console.log("[socket] disconnected: ", reason);
        });

        socket.on("connect_error", (err) => {
          console.warn("[socket] connect_error: ", err);
        });

        return () => {
          if (socketRef.current) {
            socketRef.current.off();
            socketRef.current.disconnect();
            socketRef.current = null;
          }
        };
    }, [isAuthenticated, currentUser, currentUserId, handleReservationEvent]);

    // polling to verify when access is granted
    useEffect(() => {
        const POLL_INTERVAL = 10000; // 10 seconds
        let intervalId = null;
        let mounted = true;

        const checkStatus = async () => {
            if (!currentUser || !reservationId) {
              setIsAccessGranted(false);
              return;
            }

            const command = await fetchAvailabilityStatus(currentUser, reservationId);

            if (!mounted) return;

            if (command === 'start_configuration') {
                setIsAccessGranted(true);

                if (intervalId) {
                    clearInterval(intervalId);
                    intervalId = null;
                }

            } else if (command === 'wait_configuration') {

                setIsAccessGranted(false);
                if (!intervalId) {
                    intervalId = setInterval(checkStatus, POLL_INTERVAL);
                }
            }
        };

        if (isReservationActive && currentUser && reservationId) {
            checkStatus();
        } else {
            setIsAccessGranted(false);
        }

        return () => {
            mounted = false;
            if (intervalId) {
              clearInterval(intervalId);
            }
        };
    }, [isReservationActive, currentUser, reservationId, fetchAvailabilityStatus]);

    // ensure we check reservation status whenever currentUser changes (in case of page reloads / restore)
    useEffect(() => {
        if (currentUser) checkActiveReservation(currentUser);
    }, [currentUser, checkActiveReservation]);

    const checkEvaluationAccess = useCallback(async () => {
        if (!reservationId) {
            setIsEvaluationAccessGranted(false);
            return false;
        }

        try {
            // Check esperimento running
            const statusResponse = await fetch('http://localhost:5004/api/experimenter/getExperimentStatus', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id: reservationId })
            });
            const statusData = await statusResponse.json();

            if (statusData.success && statusData.running) {
                setIsEvaluationAccessGranted(false);
                return false;
            }

            // Check risultati disponibili
            const resultsResponse = await fetch('http://localhost:5005/api/evaluator/getExperimentResults', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reservation_id: reservationId })
            });
            const resultsData = await resultsResponse.json();

            if (resultsData.success) {
                setIsEvaluationAccessGranted(true);
                return true;
            } else {
                setIsEvaluationAccessGranted(false);
                return false;
            }

        } catch (error) {
            console.error('Error checking evaluation access:', error);
            setIsEvaluationAccessGranted(false);
            return false;
        }
    }, [reservationId]);

    // wrapper component to show layout and content
    const NavbarWrapper = ({ children }) => (
        <NavbarLayout onLogout={handleLogout} activeReservationExpiration={activeReservationExpiration} isReservationActive={isReservationActive} isAccessGranted={isAccessGranted} isEvaluationAccessGranted={isEvaluationAccessGranted} checkEvaluationAccess={checkEvaluationAccess}>
            {children}
        </NavbarLayout>
    );

    return (
        // routing logic
        <Routes>
            {/* Login/Registration route (Public) */} {/* if the path is login, if the login has success, change to home (/) with replace to avoid accidentally go back to log in, otherwise stay on log in page*/}
            <Route
                path="/login"
                element={
                    isAuthenticated ? (
                        <Navigate to="/" replace />
                    ) : (
                        <AuthForm onAuthSuccess={handleLoginSuccess} />
                    )
                }
            />

            {/* Protected route (Home page), accessible only after authentication */}
            <Route element={<ProtectedRoute isAuthenticated={isAuthenticated} />}>

                {/* Home Page */}
                <Route path="/" element={<NavbarWrapper><Home username={currentUser} isAdmin={isAdmin} userId={currentUserId}/></NavbarWrapper>} />
                <Route path="/reservation" element={<NavbarWrapper><Reservation username={currentUser} isReservationActive={isReservationActive} /> </NavbarWrapper>} />
                <Route path="/configuration" element={<NavbarWrapper><ProtectedPageGuard isReservationActive={isReservationActive} isAccessGranted={isAccessGranted}><Configuration username={currentUser} reservation_id={reservationId}/> </ProtectedPageGuard></NavbarWrapper>} />
                <Route path="/experiment" element={<NavbarWrapper><ProtectedPageGuard isReservationActive={isReservationActive} isAccessGranted={isAccessGranted}><Experiment username={currentUser} reservation_id={reservationId}/> </ProtectedPageGuard></NavbarWrapper>} />
                <Route path="/evaluation" element={<NavbarWrapper><ProtectedPageGuard isReservationActive={isReservationActive} isAccessGranted={isEvaluationAccessGranted}><Evaluation username={currentUser} reservation_id={reservationId}/></ProtectedPageGuard></NavbarWrapper>} />
            </Route>

            {/* default route for not found path */}
            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    );
}

export default App;
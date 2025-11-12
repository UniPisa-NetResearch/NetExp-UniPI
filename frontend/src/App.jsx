import React, { useState, useEffect, useRef, useCallback} from 'react';
import { Routes, Route, Navigate, Outlet, useNavigate } from 'react-router-dom'; // router components
import { io } from 'socket.io-client';
import AuthForm from './AuthForm.jsx';
import NavbarLayout from './NavbarLayout.jsx';
import Home from './Home.jsx';
import Reservation from './Reservation.jsx';
import Configuration from './Configuration.jsx';

const ConfigurationGuard = ({ isReservationPermitted, children }) => {
  const navigate = useNavigate();

  useEffect(() => {
    if (!isReservationPermitted) {
       alert('Access denied: you do not have an active reservation token');
      // go back in the chronology
      // if chronology miss, go back to home
      if (window.history.length > 1) {
        navigate(-1);
      } else {
        navigate('/', { replace: true });
      }
    }
  }, [isReservationPermitted, navigate]);

  if (!isReservationPermitted) {
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

    // tracks if a reservation is active (token granted) to show the timer
    const [isReservationActive, setIsReservationActive] = useState(false);
    // stores the expiration time for the active reservation
    const [activeReservationExpiration, setActiveReservationExpiration] = useState(null);

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
                    setActiveReservationExpiration(data.expires_at);
                } else {
                    setIsReservationActive(false);
                    setActiveReservationExpiration(null);
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
        }
    }, []);

    // set authentication and username after success
    const handleLoginSuccess = (userData) => {
        setIsAuthenticated(true);
        setCurrentUser(userData.username);
        setCurrentUserId(userData.user_id);

        checkActiveReservation(userData.username);
    };

    // logout function
    const handleLogout = () => {
        setIsAuthenticated(false);
        setCurrentUser(null);
        setCurrentUserId(null);
        // reset all reservation states on logout
        setIsReservationActive(false);
        setActiveReservationExpiration(null);

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
        } else if (payload.type === "revoked") {
            // event revoked: stop timer and block access
            setIsReservationActive(false);
            setActiveReservationExpiration(null);
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

    // ensure we check reservation status whenever currentUser changes (in case of page reloads / restore)
    useEffect(() => {
        if (currentUser) checkActiveReservation(currentUser);
    }, [currentUser, checkActiveReservation]);

    // wrapper component to show layout and content
    const NavbarWrapper = ({ children }) => (
        <NavbarLayout onLogout={handleLogout} activeReservationExpiration={activeReservationExpiration} isReservationActive={isReservationActive}>
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
                <Route path="/" element={<NavbarWrapper><Home username={currentUser} /></NavbarWrapper>} />
                <Route path="/reservation" element={<NavbarWrapper><Reservation username={currentUser} isReservationActive={isReservationActive} /> </NavbarWrapper>} />
                <Route path="/configuration" element={<NavbarWrapper><ConfigurationGuard isReservationPermitted={isReservationActive}><Configuration username={currentUser} /> </ConfigurationGuard></NavbarWrapper>} />
                {/* Nuove Pagine (usano lo stesso layout) */}
                {/* <Route path="/configuration" element={<NavbarWrapper>{/* <ConfigurationPage /> *//*}</NavbarWrapper>} />*/}
                {/* ... (ecc.) */}
            </Route>

            {/* default route for not found path */}
            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    );
}

export default App;
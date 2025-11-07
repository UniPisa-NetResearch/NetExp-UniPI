import React, { useState, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'; // router components
import { io } from 'socket.io-client';
import AuthForm from './AuthForm.jsx';
import NavbarLayout from './NavbarLayout.jsx';
import Home from './Home.jsx';
import Reservation from './Reservation.jsx';
import Configuration from './Configuration.jsx';

//Component to protect the routes
const ProtectedRoute = ({ isAuthenticated}) => {
    if (!isAuthenticated) {
        // if the user is not authenticated, redirect to /login
        return <Navigate to="/login" replace />;
    }
    // otherwise shows teh content of nested route
    return <Outlet />;
};

function App() {
  // state to trace authentication and username
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);
    const [currentUserId, setCurrentUserId] = useState(null);

     const socketRef = useRef(/** @type {any} */ (null));

    // set authentication and username after success
    const handleLoginSuccess = (userData) => {
        setIsAuthenticated(true);
        setCurrentUser(userData.username);
        setCurrentUserId(userData.user_id);
    };

    // logout function
    const handleLogout = () => {
        setIsAuthenticated(false);
        setCurrentUser(null);
        setCurrentUserId(null);
         if (socketRef.current) {
          socketRef.current.emit('logout', { user_id: currentUserId });
          socketRef.current.disconnect();
          socketRef.current = null;
        }
    }

    useEffect(() => {

        if (!isAuthenticated || !currentUser || !currentUserId) return;

        const serverUrl = "http://localhost:5001"; // orchestrator socket server

        // crea e connetti
        const socket = io(serverUrl, {
          transports: ["websocket"],
          autoConnect: true,
          reconnectionAttempts: 5,
          reconnectionDelay: 1000
        });
        socketRef.current = socket;

        socket.on("connect", () => {
          console.log("[socket] connected", socket.id);
          //socket.emit("identify", { user_id: currentUserId, username: currentUser });
          socket.emit("identify", /** @type {any} */ ({ user_id: currentUserId, username: currentUser }));
        });

        socket.on("connected", (msg) => {
          console.log("[socket] server acknowledged connect:", msg);
        });

        socket.on("identify_ack", (ack) => {
          console.log("[socket] identify_ack", ack);
          // dopo ack effettua controllo endpoint per aggiornamenti in caso di client offline
        });

        socket.on("reservation_event", (payload) => {
          // payload.type == 'granted' | 'revoked'
          console.log("[socket] reservation_event", payload);
          if (payload.type === "granted") {
            //avvia timer navbar
          } else if (payload.type === "revoked") {
            // rimuovi token e azzera timer
          }
        });

        socket.on("disconnect", (reason) => {
          console.log("[socket] disconnected", reason);
        });

        socket.on("connect_error", (err) => {
          console.warn("[socket] connect_error", err);
        });

        return () => {
          if (socketRef.current) {
            socketRef.current.off();
            socketRef.current.disconnect();
            socketRef.current = null;
          }
        };
    }, [isAuthenticated, currentUser]);

    // wrapper component to show layout and content
    const NavbarWrapper = ({ children }) => (
        <NavbarLayout onLogout={handleLogout}>
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
                <Route path="/reservation" element={<NavbarWrapper><Reservation username={currentUser} /> </NavbarWrapper>} />
                <Route path="/configuration" element={<NavbarWrapper><Configuration username={currentUser} /> </NavbarWrapper>} />
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
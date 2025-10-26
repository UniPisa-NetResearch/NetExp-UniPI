import React, { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom'; // router components
import AuthForm from './AuthForm.jsx';
import Home from './Home.jsx';

//Component to protect the routes
const ProtectedRoute = ({ isAuthenticated, children }) => {
    if (!isAuthenticated) {
        // if the user is not authenticated, redirect to /login
        return <Navigate to="/login" replace />;
    }
    // otherwise shows children components
    return children;
};

function App() {
  // state to trace authentication and username
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [currentUser, setCurrentUser] = useState(null);

    // set authentication and username after success
    const handleLoginSuccess = (username) => {
        setIsAuthenticated(true);
        setCurrentUser(username);
    };

    // logout function
    const handleLogout = () => {
        setIsAuthenticated(false);
        setCurrentUser(null);
    }

    return (
        // routing logic
        <Routes>
            {/* Login/Registrazione route (Public) */} {/* if the path is login, if the login has success, change to home (/) with replace to avoid accidentally go back to log in, otherwise stay on log in page*/}
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
            <Route
                path="/"
                element={
                    <ProtectedRoute isAuthenticated={isAuthenticated}>
                        <Home username={currentUser} onLogout={handleLogout} />
                    </ProtectedRoute>
                }
            />

            {/* default route for not found path */}
            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    );
}

export default App;
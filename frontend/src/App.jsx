import React, { useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'; // router components
import AuthForm from './AuthForm.jsx';
import NavbarLayout from './NavbarLayout.jsx';
import Home from './Home.jsx';

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

                {/* Nuove Pagine (usano lo stesso layout) */}
                { /*<Route path="/reservation" element={<NavbarWrapper>{/* <ReservationPage /> *//*}</NavbarWrapper>} /> */}
                {/* <Route path="/configuration" element={<NavbarWrapper>{/* <ConfigurationPage /> *//*}</NavbarWrapper>} />*/}
                {/* ... (ecc.) */}
            </Route>

            {/* default route for not found path */}
            <Route path="*" element={<Navigate to="/" />} />
        </Routes>
    );
}

export default App;
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [schedule, setSchedule] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    // axios is the API client that loads patient data; data.json stands in for the
    // scheduling API and is served by the app itself (public/), with synthetic data only.
    axios.get('/data.json')
      .then(res => setSchedule(res.data))
      .catch(err => setError(err.message));
  }, []);

  return (
    <div className="App">
      <div className="banner">Demo environment: synthetic data only, no real patient information.</div>
      <header className="header">
        <h1>Patient Portal</h1>
        <p className="subtitle">{schedule ? `${schedule.clinic}: today's appointments` : 'Today\'s appointments'}</p>
      </header>

      <main className="content">
        {error && <p className="error" role="alert">Could not load appointments: {error}</p>}
        {!error && !schedule && <p className="loading">Loading appointments…</p>}
        {schedule && (
          <table className="appointments">
            <thead>
              <tr>
                <th>Time</th>
                <th>Patient</th>
                <th>MRN</th>
                <th>Provider</th>
                <th>Visit type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {schedule.appointments.map(appt => (
                <tr key={appt.id}>
                  <td>{appt.time}</td>
                  <td>{appt.patient}</td>
                  <td className="mono">{appt.mrn}</td>
                  <td>{appt.provider}</td>
                  <td>{appt.type}</td>
                  <td>
                    <span className={`status status-${appt.status.toLowerCase().replace(/\s+/g, '-')}`}>
                      {appt.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </div>
  );
}

export default App;

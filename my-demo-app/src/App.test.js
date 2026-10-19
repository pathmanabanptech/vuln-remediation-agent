import { render, screen } from '@testing-library/react';
import axios from 'axios';
import App from './App';

// No real network call in tests; also keeps Jest from loading axios' own module format.
jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

const schedule = {
  clinic: 'Test Clinic',
  appointments: [
    { id: 'T-1', patient: 'Test Patient', mrn: 'SYN-000001', time: '09:00', provider: 'Dr. Test', type: 'Check-up', status: 'Scheduled' },
  ],
};

test('loads appointments with axios and lists them', async () => {
  // Set per test: react-scripts resets mock implementations before each test.
  axios.get.mockResolvedValue({ data: schedule });

  render(<App />);
  expect(screen.getByText(/synthetic data only/i)).toBeInTheDocument();
  expect(await screen.findByText('Test Patient')).toBeInTheDocument();
  expect(screen.getByText('SYN-000001')).toBeInTheDocument();
  expect(axios.get).toHaveBeenCalledWith('/data.json');
});

test('shows an error message when appointments fail to load', async () => {
  axios.get.mockRejectedValue(new Error('Network Error'));

  render(<App />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load appointments: Network Error');
});

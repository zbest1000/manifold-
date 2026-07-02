import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import TopicGraph from './pages/TopicGraph';
import Brokers from './pages/Brokers';
import OpcUa from './pages/OpcUa';
import Cesmii from './pages/Cesmii';
import I3x from './pages/I3x';
import Discovery from './pages/Discovery';
import Settings from './pages/Settings';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="topics" element={<TopicGraph />} />
        <Route path="brokers" element={<Brokers />} />
        <Route path="opcua" element={<OpcUa />} />
        <Route path="cesmii" element={<Cesmii />} />
        <Route path="i3x" element={<I3x />} />
        <Route path="discovery" element={<Discovery />} />
        <Route path="settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

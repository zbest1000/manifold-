import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout';
import Overview from './pages/Overview';
import TopicGraph from './pages/TopicGraph';
import Uns from './pages/Uns';

// Route-level code splitting: only the core explore surfaces (Overview,
// Topics, UNS) ship in the main bundle; everything else loads on first visit.
const Flows = lazy(() => import('./pages/Flows'));
const Pipelines = lazy(() => import('./pages/Pipelines'));
const Tags = lazy(() => import('./pages/Tags'));
const Brokers = lazy(() => import('./pages/Brokers'));
const OpcUa = lazy(() => import('./pages/OpcUa'));
const Cesmii = lazy(() => import('./pages/Cesmii'));
const I3x = lazy(() => import('./pages/I3x'));
const Discovery2 = lazy(() => import('./pages/Discovery'));
const Settings2 = lazy(() => import('./pages/Settings'));

const Loading = () => <div className="grid h-full place-items-center text-sm text-slate-500">Loading…</div>;
const S = ({ children }) => <Suspense fallback={<Loading />}>{children}</Suspense>;

// Internal, unlinked benchmark/verification page for the big-graph renderers.
const Bench = lazy(() => import('./pages/Bench'));

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Overview />} />
        <Route path="topics" element={<TopicGraph />} />
        <Route path="uns" element={<Uns />} />
        <Route path="flows" element={<S><Flows /></S>} />
        <Route path="pipelines" element={<S><Pipelines /></S>} />
        <Route path="tags" element={<S><Tags /></S>} />
        <Route path="brokers" element={<S><Brokers /></S>} />
        <Route path="opcua" element={<S><OpcUa /></S>} />
        <Route path="cesmii" element={<S><Cesmii /></S>} />
        <Route path="i3x" element={<S><I3x /></S>} />
        <Route path="discovery" element={<S><Discovery2 /></S>} />
        <Route path="settings" element={<S><Settings2 /></S>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
      <Route
        path="/bench"
        element={
          <Suspense fallback={<div className="grid h-screen place-items-center text-slate-400">Loading bench…</div>}>
            <Bench />
          </Suspense>
        }
      />
    </Routes>
  );
}

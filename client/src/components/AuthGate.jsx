import { useEffect, useState } from 'react';
import { Lock, KeyRound } from 'lucide-react';
import { getAuthToken, setAuthToken } from '@/lib/api';
import { reconnectSocket } from '@/lib/socket';
import { Card, Button, Input } from '@/components/ui';

/**
 * Boot-time auth gate. Probes an authenticated endpoint once: if the server was
 * started with MANIFOLD_AUTH_TOKEN and we don't hold a valid token, everything would
 * 401 — so show a single unlock screen instead of a broken app. Servers running
 * without auth pass straight through.
 */
export default function AuthGate({ children }) {
  const [state, setState] = useState('checking'); // checking | locked | open
  const [token, setToken] = useState('');
  const [error, setError] = useState(null);

  const probe = async (candidate) => {
    const res = await fetch('/api/system/status', {
      headers: candidate ? { Authorization: `Bearer ${candidate}` } : {}
    });
    return res.status !== 401;
  };

  useEffect(() => {
    probe(getAuthToken()).then((ok) => setState(ok ? 'open' : 'locked'));
  }, []);

  const unlock = async (e) => {
    e.preventDefault();
    setError(null);
    if (await probe(token.trim())) {
      setAuthToken(token.trim());
      reconnectSocket();
      setState('open');
    } else {
      setError('That token was rejected by the server.');
    }
  };

  if (state === 'open') return children;
  if (state === 'checking') {
    return <div className="grid h-screen place-items-center bg-surface-950 text-sm text-slate-500">Connecting…</div>;
  }

  return (
    <div className="grid h-screen place-items-center bg-surface-950 p-6">
      <Card className="w-full max-w-sm p-6">
        <div className="mb-1 flex items-center gap-2 text-base font-semibold text-slate-100">
          <Lock size={18} className="text-accent-400" /> Manifold is locked
        </div>
        <p className="mb-4 text-xs leading-relaxed text-slate-400">
          This server requires an access token (<code>MANIFOLD_AUTH_TOKEN</code>). Enter it to unlock the console — it controls live brokers and equipment, so it&apos;s not open by default.
        </p>
        <form onSubmit={unlock} className="space-y-3">
          <Input
            type="password"
            autoFocus
            placeholder="Access token"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          {error && <p className="text-xs text-rose-300">{error}</p>}
          <Button type="submit" disabled={!token.trim()} className="w-full">
            <KeyRound size={14} className="mr-1.5" /> Unlock
          </Button>
        </form>
      </Card>
    </div>
  );
}

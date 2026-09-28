import type { ConnectionResult } from './models';

export function ConnectionTestResult({ result }: { result?: ConnectionResult }) {
    const state = result?.testing ? 'testing' : result?.success ? 'success' : result && result.success === false ? 'error' : 'idle';
    const message = result?.testing ? 'Testing connection…' : result?.data?.message || (state === 'success' ? 'Connection successful' : state === 'error' ? 'Connection failed' : 'Not tested');
    return <div className={`connection-test-result ${state}`} role={state === 'error' ? 'alert' : 'status'} aria-live="polite">
        <span aria-hidden="true">{state === 'success' ? '✓' : state === 'error' ? '!' : state === 'testing' ? '…' : '○'}</span>
        <span>{message}</span>
    </div>;
}

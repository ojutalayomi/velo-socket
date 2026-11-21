/** Call history cards: a `Call` chat message whose content is this JSON. Pure, no DB imports. */

export type CallOutcome = 'completed' | 'missed' | 'declined';

export interface CallRecord {
  callType: 'audio' | 'video';
  outcome: CallOutcome;
  /** Talk time in whole seconds; 0 unless the call connected. */
  durationSec: number;
  /** People who were in the call at any point (including the caller). */
  participants: number;
  /** Whoever started the call. */
  callerId: string;
}

/** A call that connected is "completed"; one nobody picked up is "missed" (or "declined" in a DM). */
export function callOutcome(call: { connectedAt?: number; status: string }): CallOutcome {
  if (call.connectedAt) return 'completed';
  return call.status === 'declined' ? 'declined' : 'missed';
}

export function buildCallRecord(
  call: {
    callType: 'audio' | 'video';
    callerId: string;
    connectedAt?: number;
    status: string;
    peakParticipants: number;
  },
  endTime: number
): CallRecord {
  const outcome = callOutcome(call);
  return {
    callType: call.callType,
    outcome,
    durationSec: outcome === 'completed' && call.connectedAt ? Math.max(0, Math.round((endTime - call.connectedAt) / 1000)) : 0,
    participants: Math.max(1, call.peakParticipants),
    callerId: call.callerId,
  };
}

export function parseCallRecord(content: unknown): CallRecord | null {
  if (typeof content !== 'string') return null;
  try {
    const raw = JSON.parse(content) as Partial<CallRecord>;
    if (raw.callType !== 'audio' && raw.callType !== 'video') return null;
    if (raw.outcome !== 'completed' && raw.outcome !== 'missed' && raw.outcome !== 'declined') return null;
    if (typeof raw.callerId !== 'string') return null;
    return {
      callType: raw.callType,
      outcome: raw.outcome,
      durationSec: Number.isFinite(raw.durationSec) ? Math.max(0, Math.floor(raw.durationSec as number)) : 0,
      participants: Number.isFinite(raw.participants) ? Math.max(1, Math.floor(raw.participants as number)) : 1,
      callerId: raw.callerId,
    };
  } catch {
    return null;
  }
}

export function formatCallDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

/** One line for notifications, previews and the AI's context. */
export function callPreview(record: CallRecord): string {
  const kind = record.callType === 'video' ? 'Video call' : 'Voice call';
  if (record.outcome === 'completed') return `📞 ${kind} · ${formatCallDuration(record.durationSec)}`;
  return `📞 ${record.outcome === 'declined' ? 'Declined' : 'Missed'} ${kind.toLowerCase()}`;
}

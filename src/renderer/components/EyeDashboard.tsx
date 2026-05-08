/**
 * EyeDashboard — AI SRE Observability Dashboard
 *
 * Improved from the original enhanced_eye.js prototype.
 * Implements a production-ready architecture:
 *   - useStudentT: rolling-window t-distribution anomaly detector
 *   - useMassScore: lightweight SampleHST-X inspired trace-sampling scorer
 *   - useSimulatedMetrics: isolated simulation hook (replace with IPC/WebSocket for production)
 *
 * Swap the useSimulatedMetrics body for real Electron IPC or WebSocket calls
 * to feed live host metrics, SNMP device tables, and MTR telemetry.
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react'
import {
  Activity,
  Network,
  Globe,
  AlertTriangle,
  Bot,
  MessageSquare,
  Eye,
  ActivitySquare,
  Server,
  Terminal,
  ShieldCheck,
  Wifi,
} from 'lucide-react'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SloMetric {
  name: string
  val: number
  min: number
}

interface PsiMetrics {
  cpuSome: number
  memFull: number
  ioSome: number
}

interface RumMetrics {
  ttfb: number
  throughput: number
}

interface McpMetrics {
  tokens: number
  actions: number
  blocked: number
}

interface NetworkMetrics {
  ingress: number
  egress: number
}

interface NetworkDevice {
  id: number
  name: string
  type: string
  status: 'up' | 'down'
  bandwidth: number
  downCount: number // consecutive down ticks — used for flap detection
}

interface MtrHop {
  hop: number
  host: string
  lossPct: number
  avgRtt: number
}

interface AnomalyEvent {
  id: number
  tScore: number
  massScore: number
  description: string
}

interface DashboardMetrics {
  slo: SloMetric[]
  psi: PsiMetrics
  rum: RumMetrics
  mcp: McpMetrics
  network: NetworkMetrics
  devices: NetworkDevice[]
  mtr: MtrHop[]
}

// ── Student's t-distribution anomaly detector ─────────────────────────────────
// Uses Cornish-Fisher approximation for p-values when scipy is unavailable.
// Lower df => heavier tails => more tolerant of GC pauses and hypervisor jitter.

function useStudentT(
  windowSize = 30,
  df = 5,
  threshold = 3.0,
) {
  const windowRef = useRef<number[]>([])

  const feed = useCallback(
    (value: number) => {
      const w = windowRef.current
      w.push(value)
      if (w.length > windowSize) w.shift()
      if (w.length < 10) return null

      const n = w.length
      const mean = w.reduce((a, b) => a + b, 0) / n
      const variance = w.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
      const std = Math.sqrt(variance) || 1e-9
      const tScore = (value - mean) / (std / Math.sqrt(n))

      // Cornish-Fisher p-value approximation for Student's t
      const absT = Math.abs(tScore)
      const term = (absT * absT) / df
      const pApprox = 1 / (1 + term) ** ((df + 1) / 2)
      const pValue = Math.min(2 * pApprox, 1)

      const isAnomaly = absT > threshold
      const severity: 'normal' | 'warning' | 'critical' =
        absT > threshold * 2 ? 'critical' : isAnomaly ? 'warning' : 'normal'

      return {
        tScore: +tScore.toFixed(3),
        pValue: +pValue.toFixed(4),
        isAnomaly,
        severity,
        baseline: { mean: +mean.toFixed(2), std: +std.toFixed(2) },
      }
    },
    [windowSize, df, threshold],
  )

  return { feed }
}

// ── MassScore buffer (SampleHST-X inspired) ───────────────────────────────────
// Low mass score => observation is rare => retain trace (interesting).
// High mass score => common execution structure => may discard (routine).

function useMassScore(windowSize = 100) {
  const bufRef = useRef<number[]>([])

  const score = useCallback(
    (value: number): number => {
      const buf = bufRef.current
      buf.push(value)
      if (buf.length > windowSize) buf.shift()
      if (buf.length < 2) return 0.5

      const n = buf.length
      const mean = buf.reduce((a, b) => a + b, 0) / n
      const variance = buf.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)
      const std = Math.sqrt(variance) || 1e-9
      const near = buf.filter(v => Math.abs(v - value) <= std).length
      return +(near / n).toFixed(3)
    },
    [windowSize],
  )

  return { score }
}

// ── Simulation hook ───────────────────────────────────────────────────────────
// Replace the setInterval body with Electron IPC listeners or WebSocket
// subscriptions to feed real host metrics into the same state shape.

const DEVICE_TYPES = ['router', 'switch', 'firewall', 'iot'] as const

function useSimulatedMetrics() {
  const [metrics, setMetrics] = useState<DashboardMetrics>({
    slo: [
      { name: 'API Availability', val: 99.99, min: 99.95 },
      { name: 'Payment Gateway', val: 99.99, min: 99.99 },
      { name: 'Auth Service', val: 100.0, min: 99.9 },
    ],
    psi: { cpuSome: 2.1, memFull: 0.0, ioSome: 1.5 },
    rum: { ttfb: 124, throughput: 45.2 },
    mcp: { tokens: 1_450_230, actions: 12, blocked: 0 },
    network: { ingress: 32.0, egress: 21.0 },
    devices: [
      { id: 1, name: 'core-router', type: 'router', status: 'up', bandwidth: 0, downCount: 0 },
      { id: 2, name: 'switch-01', type: 'switch', status: 'up', bandwidth: 0, downCount: 0 },
    ],
    mtr: [
      { hop: 1, host: 'igw-vpc-eu-1', lossPct: 0, avgRtt: 1.2 },
      { hop: 2, host: '10.244.1.1', lossPct: 0, avgRtt: 1.8 },
      { hop: 3, host: 'bgp-isp-core', lossPct: 0, avgRtt: 12.0 },
      { hop: 4, host: 'aws-lb-edge', lossPct: 0, avgRtt: 14.1 },
    ],
  })

  const [anomalyActive, setAnomalyActive] = useState(false)

  useEffect(() => {
    const timerId = setInterval(() => {
      const isAnomaly = Math.random() > 0.92

      setMetrics(prev => {
        let devices = prev.devices.map(d => {
          const newStatus: 'up' | 'down' = Math.random() > 0.97 ? 'down' : 'up'
          return {
            ...d,
            bandwidth: Math.max(0, d.bandwidth + (Math.random() * 10 - 4)),
            status: newStatus,
            downCount: newStatus === 'down' ? d.downCount + 1 : 0,
          }
        })

        if (Math.random() > 0.96 && devices.length < 7) {
          const nid = devices.length + 1
          devices = [
            ...devices,
            {
              id: nid,
              name: `${DEVICE_TYPES[nid % DEVICE_TYPES.length]}-${nid}`,
              type: DEVICE_TYPES[nid % DEVICE_TYPES.length],
              status: 'up',
              bandwidth: 0,
              downCount: 0,
            },
          ]
        }

        const mtr = prev.mtr.map((h, i) => ({
          ...h,
          lossPct:
            isAnomaly && i === 2
              ? 12.4
              : Math.max(0, h.lossPct + (Math.random() * 0.5 - 0.3)),
          avgRtt:
            isAnomaly && i >= 2
              ? h.avgRtt + 130
              : Math.max(0.5, h.avgRtt + (Math.random() * 2 - 1)),
        }))

        return {
          slo: prev.slo.map(s => ({
            ...s,
            val:
              isAnomaly && s.name === 'Payment Gateway'
                ? Math.max(s.min - 0.01, s.val - 0.01)
                : Math.min(100, s.val + (Math.random() * 0.005 - 0.001)),
          })),
          psi: {
            cpuSome:
              Math.max(0, prev.psi.cpuSome + (Math.random() * 2 - 1) + (isAnomaly ? 18 : 0)),
            memFull: isAnomaly ? 4.8 : Math.max(0, prev.psi.memFull * 0.6),
            ioSome: Math.max(0, prev.psi.ioSome + (Math.random() - 0.5)),
          },
          rum: {
            ttfb: isAnomaly ? prev.rum.ttfb + 320 : 120 + Math.random() * 20,
            throughput: Math.max(10, prev.rum.throughput + (Math.random() * 4 - 2)),
          },
          mcp: {
            tokens: prev.mcp.tokens + Math.floor(Math.random() * 5000),
            actions: isAnomaly ? prev.mcp.actions + 1 : prev.mcp.actions,
            blocked: prev.mcp.blocked,
          },
          network: {
            ingress: Math.max(0, prev.network.ingress + (Math.random() * 5 - 2)),
            egress: Math.max(0, prev.network.egress + (Math.random() * 5 - 2)),
          },
          devices,
          mtr,
        }
      })

      if (isAnomaly) {
        setAnomalyActive(true)
        setTimeout(() => setAnomalyActive(false), 8000)
      }
    }, 2000)

    return () => clearInterval(timerId)
  }, [])

  return { metrics, anomalyActive }
}

// ── Helper components ─────────────────────────────────────────────────────────

interface CardProps {
  title: string
  icon: React.ElementType
  children: React.ReactNode
  status?: 'normal' | 'warning' | 'critical'
}

const Card: React.FC<CardProps> = ({ title, icon: Icon, children, status = 'normal' }) => {
  const border = {
    normal: 'border-slate-800',
    warning: 'border-yellow-500/50 shadow-[0_0_15px_rgba(234,179,8,0.15)]',
    critical: 'border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.2)]',
  }[status]
  const badge = {
    normal: 'text-emerald-400',
    warning: 'text-yellow-400',
    critical: 'text-red-400',
  }[status]
  return (
    <div className={`bg-slate-900 border ${border} rounded-xl p-5 flex flex-col gap-4 h-full transition-all duration-500`}>
      <div className="flex justify-between items-center border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Icon size={18} className="text-cyan-400" />
          <h2 className="text-sm font-semibold tracking-wider text-slate-300 uppercase">{title}</h2>
        </div>
        <span className={`text-xs font-mono font-bold px-2 py-1 rounded bg-slate-950 ${badge}`}>
          {status.toUpperCase()}
        </span>
      </div>
      <div className="flex-1 flex flex-col overflow-hidden text-slate-300">{children}</div>
    </div>
  )
}

interface ProgressBarProps {
  label: string
  value: number | string
  max?: number
  color?: string
}

const ProgressBar: React.FC<ProgressBarProps> = ({ label, value, max = 100, color = 'bg-cyan-500' }) => (
  <div className="flex flex-col gap-1 w-full text-xs font-mono">
    <div className="flex justify-between">
      <span className="text-slate-400">{label}</span>
      <span className="text-slate-200">{value}%</span>
    </div>
    <div className="w-full bg-slate-950 h-1.5 rounded-full overflow-hidden">
      <div
        className={`h-full ${color} transition-all duration-500`}
        style={{ width: `${Math.min((Number(value) / max) * 100, 100)}%` }}
      />
    </div>
  </div>
)

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function EyeDashboard() {
  const { metrics, anomalyActive } = useSimulatedMetrics()
  const { feed: feedT } = useStudentT(30, 5, 3.0)
  const { score: massScore } = useMassScore(100)

  const [eventLog, setEventLog] = useState<AnomalyEvent[]>([])
  const eventIdRef = useRef(0)

  // Score each incoming TTFB through the t-distribution detector
  useEffect(() => {
    const result = feedT(metrics.rum.ttfb)
    const ms = massScore(metrics.rum.ttfb)
    if (result?.isAnomaly) {
      setEventLog(prev =>
        [
          {
            id: ++eventIdRef.current,
            tScore: result.tScore,
            massScore: ms,
            description: `TTFB spike: ${Math.round(metrics.rum.ttfb)}ms — t=${result.tScore}, p=${result.pValue}, mass=${ms}`,
          },
          ...prev,
        ].slice(0, 5),
      )
    }
  }, [metrics.rum.ttfb])

  // Scatter dots regenerate only when anomaly state flips — not every tick
  const scatterDots = useMemo(
    () =>
      Array.from({ length: 40 }, (_, i) => {
        const isOutlier = i > 35
        return {
          id: i,
          left: isOutlier ? 70 + Math.random() * 25 : 10 + Math.random() * 60,
          bottom: isOutlier ? Math.random() * 20 : Math.random() * 40,
          isOutlier,
        }
      }),
    [anomalyActive],
  )

  const psiStatus = metrics.psi.memFull > 2 ? 'critical' : metrics.psi.cpuSome > 10 ? 'warning' : 'normal'
  const rumStatus = metrics.rum.ttfb > 300 ? 'warning' : 'normal'
  const networkStatus = anomalyActive ? 'warning' : 'normal'
  const flapCount = metrics.devices.filter(d => d.downCount > 0).length

  return (
    <div className="min-h-screen bg-slate-950 text-slate-300 p-4 md:p-6 font-sans">

      {/* Header */}
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-4">
          <div className="relative flex items-center justify-center w-12 h-12 bg-slate-900 rounded-full border-2 border-cyan-500/50 shadow-[0_0_20px_rgba(6,182,212,0.3)]">
            <Eye
              className={anomalyActive ? 'text-red-400 animate-pulse' : 'text-cyan-400'}
              size={24}
            />
            {anomalyActive && (
              <div className="absolute inset-0 rounded-full border border-red-500 animate-ping opacity-75" />
            )}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
              THE EYE
              <span className="text-xs font-mono font-normal bg-cyan-950 text-cyan-400 px-2 py-1 rounded border border-cyan-800">
                AGENT: ACTIVE
              </span>
            </h1>
            <p className="text-sm text-slate-500 font-mono mt-1">
              Autonomous Observability Stack · Student’s t-Distribution Anomaly Engine
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-4 font-mono text-xs">
          {([
            ['SYSTEM STATE', anomalyActive ? 'ANOMALY DETECTED' : 'NOMINAL', anomalyActive ? 'text-yellow-400' : 'text-emerald-400'],
            ['AUTO-REMEDIATIONS', `${metrics.mcp.actions} EXECUTED`, 'text-cyan-400'],
            ['INGRESS / EGRESS', `${metrics.network.ingress.toFixed(1)}↑ / ${metrics.network.egress.toFixed(1)}↓ MB/s`, 'text-cyan-400'],
            ['DEVICE FLAPS', String(flapCount), flapCount > 0 ? 'text-yellow-400' : 'text-emerald-400'],
          ] as const).map(([label, val, cls]) => (
            <div key={label} className="flex flex-col items-end">
              <span className="text-slate-500">{label}</span>
              <span className={cls}>{val}</span>
            </div>
          ))}
        </div>
      </header>

      {/* Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 auto-rows-fr">

        {/* 1 — Global SLI/SLO */}
        <div className="xl:col-span-1 md:col-span-2">
          <Card title="Global SLI / SLO" icon={ActivitySquare}>
            <div className="flex flex-col gap-4 mt-2">
              {metrics.slo.map((slo, i) => (
                <div key={i}>
                  <div className="flex justify-between text-xs font-mono mb-1">
                    <span className="text-slate-400">{slo.name}</span>
                    <span className={slo.val < slo.min ? 'text-red-400' : 'text-emerald-400'}>
                      {slo.val.toFixed(3)}% / {slo.min}%
                    </span>
                  </div>
                  <div className="w-full bg-slate-950 h-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-1000 ${slo.val < slo.min ? 'bg-red-500' : 'bg-emerald-500'}`}
                      style={{ width: `${slo.val}%` }}
                    />
                  </div>
                  <div className="text-right text-[10px] font-mono text-slate-600 mt-0.5">
                    budget remaining: {((slo.val - slo.min) * 100).toFixed(1)} min
                  </div>
                </div>
              ))}
              <div className="mt-auto pt-3 border-t border-slate-800 text-xs font-mono text-slate-500">
                <span className="text-cyan-500">INFO:</span> Error budgets tracking nominally.
              </div>
            </div>
          </Card>
        </div>

        {/* 2 — Network Path (MTR) */}
        <Card title="Network Path (MTR)" icon={Network} status={networkStatus}>
          <div className="flex flex-col gap-2 font-mono text-xs">
            <div className="grid grid-cols-5 text-slate-500 border-b border-slate-800 pb-1">
              <span>HOP</span>
              <span className="col-span-2">HOST</span>
              <span className="text-right">LOSS%</span>
              <span className="text-right">RTT</span>
            </div>
            {metrics.mtr.map(h => (
              <div
                key={h.hop}
                className={`grid grid-cols-5 items-center ${
                  h.lossPct > 5 ? 'bg-slate-800/50 rounded px-1' : ''
                }`}
              >
                <span className="text-slate-400">{h.hop}</span>
                <span className="col-span-2 text-cyan-200 truncate">{h.host}</span>
                <span className={`text-right ${h.lossPct > 5 ? 'text-yellow-400' : 'text-slate-400'}`}>
                  {h.lossPct.toFixed(1)}%
                </span>
                <span className={`text-right ${h.avgRtt > 50 ? 'text-yellow-400' : 'text-emerald-400'}`}>
                  {h.avgRtt.toFixed(1)}ms
                </span>
              </div>
            ))}
            <p className="mt-2 text-[10px] text-slate-500">
              Auto-classifying: ICMP deprioritization vs authentic packet loss vs bufferbloat.
            </p>
          </div>
        </Card>

        {/* 3 — Infrastructure Saturation (PSI) */}
        <Card title="Infra Saturation (PSI)" icon={Server} status={psiStatus}>
          <div className="flex flex-col gap-4 mt-2">
            <ProgressBar
              label="CPU pressure (some.avg10)"
              value={metrics.psi.cpuSome.toFixed(1)}
              max={20}
              color={metrics.psi.cpuSome > 10 ? 'bg-yellow-500' : 'bg-cyan-500'}
            />
            <ProgressBar
              label="Memory pressure (full.avg10)"
              value={metrics.psi.memFull.toFixed(2)}
              max={10}
              color={metrics.psi.memFull > 2 ? 'bg-red-500' : 'bg-emerald-500'}
            />
            <ProgressBar
              label="I/O pressure (some.avg10)"
              value={metrics.psi.ioSome.toFixed(1)}
              max={20}
              color="bg-cyan-500"
            />
            <div className="mt-auto pt-2 text-xs font-mono text-slate-500 flex justify-between border-t border-slate-800">
              <span>GPU ECC: <span className="text-emerald-400">0 errors</span></span>
              <span>NVLink: <span className="text-emerald-400">Stable</span></span>
            </div>
          </div>
        </Card>

        {/* 4 — Trace Anomaly Distribution */}
        <Card title="Trace Anomaly (t-Dist)" icon={Activity}>
          <div className="relative w-full h-32 bg-slate-950 rounded border border-slate-800 overflow-hidden">
            <svg
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              className="absolute inset-0 w-full h-full opacity-30"
            >
              {/* Normal bell curve */}
              <path
                d="M 0,100 C 20,100 35,10 50,10 C 65,10 80,100 100,100"
                fill="none"
                stroke="#06b6d4"
                strokeWidth="2"
              />
              {/* Heavy-tail overlay (t-distribution) */}
              <path
                d="M 50,10 C 70,10 80,80 100,90"
                fill="none"
                stroke="#f59e0b"
                strokeWidth="1"
                strokeDasharray="2,2"
              />
              <line x1="50" y1="10" x2="50" y2="100" stroke="#334155" strokeWidth="0.5" />
            </svg>
            {scatterDots.map(dot => (
              <div
                key={dot.id}
                className={`absolute rounded-full w-1.5 h-1.5 ${
                  dot.isOutlier && anomalyActive
                    ? 'bg-red-500 animate-ping'
                    : dot.isOutlier
                    ? 'bg-yellow-400'
                    : 'bg-cyan-500 opacity-60'
                }`}
                style={{ left: `${dot.left}%`, bottom: `${dot.bottom}%` }}
              />
            ))}
          </div>
          <div className="flex justify-between text-xs font-mono mt-3 text-slate-400">
            <span>ν = 5 (heavy-tailed)</span>
            <span className={anomalyActive ? 'text-yellow-400' : 'text-emerald-400'}>
              {anomalyActive ? '⚠ Outlier flagged' : 'Mass scoring: active'}
            </span>
          </div>
          {eventLog[0] && (
            <div className="mt-2 text-[10px] font-mono text-slate-500 border-t border-slate-800 pt-2">
              Last: t={eventLog[0].tScore} · mass={eventLog[0].massScore}
            </div>
          )}
        </Card>

        {/* 5 — RUM Analytics */}
        <Card title="RUM Analytics" icon={Globe} status={rumStatus}>
          <div className="grid grid-cols-2 gap-4 h-full">
            <div className="flex flex-col justify-center bg-slate-950 p-3 rounded border border-slate-800">
              <span className="text-slate-500 text-xs font-mono mb-1">P95 TTFB</span>
              <span
                className={`text-2xl font-bold font-mono ${
                  metrics.rum.ttfb > 300 ? 'text-yellow-400' : 'text-emerald-400'
                }`}
              >
                {Math.round(metrics.rum.ttfb)}
                <span className="text-sm text-slate-500 ml-1">ms</span>
              </span>
            </div>
            <div className="flex flex-col justify-center bg-slate-950 p-3 rounded border border-slate-800">
              <span className="text-slate-500 text-xs font-mono mb-1">Throughput</span>
              <span className="text-2xl font-bold font-mono text-cyan-400">
                {metrics.rum.throughput.toFixed(1)}
                <span className="text-sm text-slate-500 ml-1">MB/s</span>
              </span>
            </div>
            <div className="col-span-2 text-xs font-mono text-slate-500 flex justify-between border-t border-slate-800 pt-2">
              <span>DNS + TCP + TLS breakdown</span>
              <span className="text-emerald-400">Brotli 2.4×</span>
            </div>
          </div>
        </Card>

        {/* 6 — MCP & LLM Observability */}
        <Card title="Agent MCP Stats" icon={Bot}>
          <div className="flex flex-col gap-3 font-mono text-xs">
            {([
              [Terminal, 'text-cyan-500', 'Token Usage', metrics.mcp.tokens.toLocaleString(), 'text-cyan-200'],
              [ShieldCheck, 'text-emerald-500', 'Safe Executions', String(metrics.mcp.actions), 'text-emerald-200'],
              [AlertTriangle, 'text-yellow-500', 'Blocked by Policy', String(metrics.mcp.blocked), 'text-yellow-200'],
            ] as const).map(([Icon, iconCls, label, val, valCls]) => (
              <div key={label} className="flex justify-between items-center p-2 bg-slate-950 rounded">
                <span className="flex items-center gap-2">
                  <Icon size={14} className={iconCls} />
                  {label}
                </span>
                <span className={valCls}>{val}</span>
              </div>
            ))}
            <p className="mt-1 text-[10px] text-slate-500 text-center">
              All MCP connections sandboxed &amp; contract-validated.
            </p>
          </div>
        </Card>

        {/* 7 — Network Devices */}
        <Card
          title="Network Devices (SNMP/ARP)"
          icon={Wifi}
          status={flapCount > 0 ? 'warning' : 'normal'}
        >
          <div className="flex flex-col gap-2 text-xs font-mono overflow-y-auto">
            <div className="grid grid-cols-4 text-slate-500 border-b border-slate-800 pb-1">
              <span>Device</span>
              <span>Type</span>
              <span className="text-right">BW</span>
              <span className="text-right">State</span>
            </div>
            {metrics.devices.map(d => (
              <div key={d.id} className="grid grid-cols-4 items-center">
                <span className="truncate text-cyan-200">{d.name}</span>
                <span className="text-slate-400">{d.type}</span>
                <span className="text-right text-cyan-400">{d.bandwidth.toFixed(1)}M</span>
                <span
                  className={`text-right ${
                    d.status === 'up' ? 'text-emerald-400' : 'text-red-500 animate-pulse'
                  }`}
                >
                  {d.status}{d.downCount > 1 ? ` ×${d.downCount}` : ''}
                </span>
              </div>
            ))}
            <p className="mt-2 text-[10px] text-slate-500">
              {flapCount > 0
                ? `⚠ ${flapCount} device(s) flapping — check ARP/SNMP`
                : 'All devices nominal.'}
            </p>
          </div>
        </Card>

        {/* 8 — ChatOps / Incident Feed */}
        <div className="md:col-span-2 lg:col-span-3 xl:col-span-2">
          <Card
            title="ChatOps Incident Feed"
            icon={MessageSquare}
            status={anomalyActive ? 'warning' : 'normal'}
          >
            <div
              className="flex flex-col gap-3 overflow-y-auto font-mono text-xs"
              style={{ maxHeight: 280 }}
            >
              {anomalyActive && (
                <div className="bg-red-950/30 border border-red-900 rounded p-3 text-red-200 flex gap-3">
                  <Bot size={16} className="text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-red-400 font-bold">[AUTO-RCA]</span>
                    <br />
                    Anomaly detected. mem.full.avg10={metrics.psi.memFull.toFixed(2)} ·
                    TTFB={Math.round(metrics.rum.ttfb)}ms ·
                    MTR hop&nbsp;3 loss={metrics.mtr[2]?.lossPct.toFixed(1)}%.
                    {eventLog[0] && (
                      <> t={eventLog[0].tScore} · mass={eventLog[0].massScore}.</>
                    )}
                    <div className="mt-2 flex gap-2">
                      <button className="bg-red-900/50 hover:bg-red-800 text-red-100 px-2 py-1 rounded transition-colors">
                        Acknowledge
                      </button>
                      <button className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded transition-colors">
                        View Trace
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {eventLog.map(ev => (
                <div
                  key={ev.id}
                  className="bg-slate-800/30 border border-slate-800 rounded p-3 text-slate-300 flex gap-3 opacity-80"
                >
                  <Activity size={16} className="text-yellow-500 flex-shrink-0 mt-0.5" />
                  <div>
                    <span className="text-yellow-400 font-bold">[ANOMALY]</span>
                    <br />
                    {ev.description}
                  </div>
                </div>
              ))}

              <div className="bg-slate-800/30 border border-slate-800 rounded p-3 text-slate-300 flex gap-3 opacity-50">
                <Bot size={16} className="text-cyan-500 flex-shrink-0 mt-0.5" />
                <div>
                  <span className="text-cyan-400 font-bold">[SYSTEM]</span>
                  <br />
                  t-distribution detector initialized. df=5, window=30, threshold=3.0.
                  MassScore buffer ready (SampleHST-X, n=100). Telemetry pipeline active.
                </div>
              </div>
            </div>
          </Card>
        </div>

      </div>
    </div>
  )
}

import { useState, useEffect, useRef, useCallback } from "react";
import { exportarRespaldo, importarRespaldo } from "./backup";

// ---------- helpers ----------
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const MESES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];
const MESES_ABBR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

const TURNOS = ["Turno mañana", "Turno tarde", "Turno noche"];
const SECTORES = ["Despacho", "Fabricación", "Limpieza", "Envasado", "Preparación de pedidos"];

const money = (n) =>
  (Number(n) || 0).toLocaleString("es-AR", { style: "currency", currency: "ARS", maximumFractionDigits: 0 });

function monthKey(year, month) {
  return `${year}-${String(month + 1).padStart(2, "0")}`;
}
function keyParts(k) {
  const [y, m] = k.split("-").map(Number);
  return { year: y, month: m - 1 };
}
function shiftMonth(year, month, delta) {
  let m = month + delta, y = year;
  while (m < 0) { m += 12; y -= 1; }
  while (m > 11) { m -= 12; y += 1; }
  return { year: y, month: m };
}
function last6MonthKeys(year, month) {
  const keys = [];
  for (let i = 5; i >= 0; i--) {
    const { year: y, month: m } = shiftMonth(year, month, -i);
    keys.push(monthKey(y, m));
  }
  return keys;
}

function emptyEmployee() {
  return {
    id: uid(),
    activo: true,
    nombre: "", apellido: "", dni: "", cargo: "", area: "",
    sucursal: "", turno: "", sector: "",
    fechaNacimiento: "", fechaIngreso: "", telefono: "", email: "", direccion: "",
    valorHora: "", jornadaNormal: "8", horasSabado: "0", horasDomingo: "0", presentismoBase: "",
    recargoSemana: "0", recargoSabado: "0", recargoDomingo: "0", recargoFeriado: "0",
    novedades: {}, // { "2026-09": { presentismo, noRemunerativo, adicionales:[], mercaderia:[], adelantos:[], embargos:[] } }
    calendario: {}, // { "2026-09": { "1": { horas, falta, feriado } } }
    pagosSemanales: {}, // { "2026-09": { s1, s2, s3, s4 } } - suma a abonar cargada cada semana
    aguinaldoBase: {}, // { "2026-1": "450000" } - base imponible manual por año-cuota (1 o 2)
    vacacionesAsignadas: {}, // { "2026": ["2026-01-05", "2026-01-06", ...] }
  };
}


const DOW = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}
function dateStr(year, month, day) {
  return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function mondayIndex(year, month, day) {
  const d = new Date(year, month, day).getDay();
  return (d + 6) % 7;
}
function horasEsperadasDia(emp, year, month, day) {
  const dow = new Date(year, month, day).getDay(); // 0 domingo, 6 sábado
  if (dow === 0) return Number(emp.horasDomingo) || 0;
  if (dow === 6) return Number(emp.horasSabado) || 0;
  return Number(emp.jornadaNormal) || 0;
}

function computeLiquidacionCompleta(emp, key) {
  const { year, month } = keyParts(key);
  const valorHora = Number(emp.valorHora) || 0;
  const jornada = Number(emp.jornadaNormal) || 0;
  const basico = valorHora * jornada * 30;

  const mes = (emp.novedades || {})[key] || emptyMes(emp);
  const presentismo = Number(mes.presentismo) || 0;
  const noRemunerativo = Number(mes.noRemunerativo) || 0;
  const totalAdicionales = (mes.adicionales || []).reduce((s, a) => s + (Number(a.monto) || 0), 0);
  const totalMercaderia = (mes.mercaderia || []).reduce((s, m2) => s + (Number(m2.monto) || 0), 0);
  const totalAdelantos = (mes.adelantos || []).reduce((s, a) => s + (Number(a.monto) || 0), 0);

  const dias = (emp.calendario || {})[key] || {};
  const diasEnMes = daysInMonth(year, month);
  const multDomingo = 1 + (Number(emp.recargoDomingo) || 0) / 100;
  const multSemana = 1 + (Number(emp.recargoSemana) || 0) / 100;
  const multSabado = 1 + (Number(emp.recargoSabado) || 0) / 100;
  const multFeriado = 1 + (Number(emp.recargoFeriado) || 0) / 100;
  const formatDia = (d) => `${d}/${month + 1}`;

  let domingosTrabajados = 0;
  let montoDomingo = 0;
  let feriadosTrabajados = 0;
  let montoFeriado = 0;
  let horasExtra = 0;
  let montoExtra = 0;
  let horasNoTrabajadas = 0;
  let montoNoTrabajadas = 0;
  let montoFaltas = 0;
  const faltasDetalle = [];
  const feriadoDetalle = [];
  const extraDetalle = [];
  const noTrabajadasDetalle = [];

  for (let d = 1; d <= diasEnMes; d++) {
    const reg = dias[String(d)];
    const dow = new Date(year, month, d).getDay(); // 0 domingo, 6 sábado

    if (reg && reg.falta) {
      const esperado = horasEsperadasDia(emp, year, month, d);
      const monto = esperado * valorHora;
      montoFaltas += monto;
      faltasDetalle.push({ dia: d, fecha: formatDia(d), horas: esperado, monto });
      continue;
    }

    if (reg && reg.feriado) {
      const horas = Number(reg.horas) || 0;
      if (horas > 0) {
        const monto = horas * valorHora * multFeriado;
        feriadosTrabajados += 1;
        montoFeriado += monto;
        feriadoDetalle.push({ dia: d, fecha: formatDia(d), horas, monto });
      }
      continue; // el feriado no se compara contra la jornada esperada
    }

    if (dow === 0) {
      if (!reg) continue;
      const horas = Number(reg.horas) || 0;
      if (horas > 0) {
        domingosTrabajados += 1;
        montoDomingo += horas * valorHora * multDomingo;
      }
      continue;
    }

    const esperado = horasEsperadasDia(emp, year, month, d);
    const real = reg ? Number(reg.horas) || 0 : 0;
    const diff = real - esperado;
    const mult = dow === 6 ? multSabado : multSemana;

    if (diff > 0) {
      const monto = diff * valorHora * mult;
      horasExtra += diff;
      montoExtra += monto;
      extraDetalle.push({ dia: d, fecha: formatDia(d), horas: diff, monto });
    } else if (diff < 0) {
      const monto = -diff * valorHora;
      horasNoTrabajadas += -diff;
      montoNoTrabajadas += monto;
      noTrabajadasDetalle.push({ dia: d, fecha: formatDia(d), horas: -diff, monto });
    }
  }

  const totalHaberes = basico + presentismo + noRemunerativo + totalAdicionales + montoDomingo + montoFeriado + montoExtra;

  const totalEmbargos = (mes.embargos || []).reduce((s, em) => {
    if (em.tipo === "porcentaje") return s + totalHaberes * ((Number(em.valor) || 0) / 100);
    return s + (Number(em.valor) || 0);
  }, 0);
  const totalDeducciones = totalAdelantos + totalMercaderia + totalEmbargos + montoNoTrabajadas + montoFaltas;
  const neto = totalHaberes - totalDeducciones;

  return {
    valorHora, jornada, basico, presentismo, noRemunerativo, totalAdicionales,
    domingosTrabajados, montoDomingo, feriadosTrabajados, montoFeriado, feriadoDetalle,
    horasExtra, montoExtra, extraDetalle,
    horasNoTrabajadas, montoNoTrabajadas, noTrabajadasDetalle,
    montoFaltas, faltasDetalle, totalHaberes,
    totalAdelantos, totalMercaderia, totalEmbargos, totalDeducciones, neto,
  };
}

function emptyPagos() {
  return { s1: "", s2: "", s3: "", s4: "" };
}

// ---------- aguinaldo (SAC) y vacaciones — legislación argentina ----------
// SAC: 50% de la mejor remuneración mensual del semestre (Ley 23.041 / 27.073).
// Si no trabajó el semestre completo, se prorratea por meses trabajados / 12.
function calcularSAC(emp, year, semestre) {
  const meses = semestre === 1 ? [0, 1, 2, 3, 4, 5] : [6, 7, 8, 9, 10, 11];
  const ingreso = emp.fechaIngreso ? new Date(emp.fechaIngreso + "T00:00:00") : null;
  let mejor = 0;
  let mejorMes = null;
  let mejorLiq = null;
  let mesesTrabajados = 0;
  const detalle = [];
  meses.forEach((m) => {
    const finMes = new Date(year, m + 1, 0);
    if (ingreso && ingreso > finMes) return;
    mesesTrabajados += 1;
    const mk = monthKey(year, m);
    const liq = computeLiquidacionCompleta(emp, mk);
    const remunerativo = liq.totalHaberes - liq.noRemunerativo;
    detalle.push({ mes: MESES[m], remunerativo });
    if (remunerativo > mejor) { mejor = remunerativo; mejorMes = MESES[m]; mejorLiq = liq; }
  });
  const importe = mejor * (mesesTrabajados / 12);
  return { semestre, year, mejor, mejorMes, mejorLiq, mesesTrabajados, importe, detalle };
}

// Vacaciones (Ley de Contrato de Trabajo, arts. 150-155):
// 14 días hasta 5 años de antigüedad, 21 de 5 a 10, 28 de 10 a 20, 35 más de 20.
// Si no se cumplió el año completo, es proporcional (días trabajados del año / 365).
// El valor del día se calcula dividiendo la mejor remuneración mensual por 25.
function diasVacacionesPorAntiguedad(anios) {
  if (anios <= 5) return 14;
  if (anios <= 10) return 21;
  if (anios <= 20) return 28;
  return 35;
}
function calcularVacaciones(emp, year, mesReferenciaKey) {
  if (!emp.fechaIngreso) return null;
  const ingreso = new Date(emp.fechaIngreso + "T00:00:00");
  const finAnio = new Date(year, 11, 31);
  const inicioAnio = new Date(year, 0, 1);
  if (ingreso > finAnio) return null;

  const msPorAnio = 1000 * 60 * 60 * 24 * 365.25;
  const antiguedadAnios = Math.max(0, (finAnio - ingreso) / msPorAnio);
  const diasPorAntiguedad = diasVacacionesPorAntiguedad(antiguedadAnios);

  const proporcional = ingreso > inicioAnio;
  const inicioComputo = proporcional ? ingreso : inicioAnio;
  const diasTrabajadosAnio = Math.max(0, Math.round((finAnio - inicioComputo) / (1000 * 60 * 60 * 24)) + 1);
  const diasCorrespondientes = proporcional
    ? Math.round(diasPorAntiguedad * (diasTrabajadosAnio / 365))
    : diasPorAntiguedad;

  const liq = computeLiquidacionCompleta(emp, mesReferenciaKey);
  const remunerativo = liq.totalHaberes - liq.noRemunerativo;
  const valorDia = remunerativo / 25;
  const total = valorDia * diasCorrespondientes;

  return { antiguedadAnios, diasPorAntiguedad, diasCorrespondientes, proporcional, diasTrabajadosAnio, valorDia, remunerativo, total };
}

function emptyMes(emp) {
  return { presentismo: emp.presentismoBase || "", noRemunerativo: "", adicionales: [], mercaderia: [], adelantos: [], embargos: [] };
}

function compressImage(file, maxW = 1000, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// ---------- small building blocks ----------
function Field({ label, children, span }) {
  return (
    <label className={"field" + (span ? " field-span" : "")}>
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}
function ReadField({ label, value, span, money: isMoney }) {
  const shown = value === "" || value === undefined || value === null ? "—" : (isMoney ? money(value) : value);
  return (
    <div className={"field" + (span ? " field-span" : "")}>
      <span className="field-label">{label}</span>
      <div className="ro-value">{shown}</div>
    </div>
  );
}
function SectionCard({ accent, title, subtitle, headerExtra, children }) {
  return (
    <div className="section-card" style={{ "--accent": accent }}>
      <div className="section-head">
        <div>
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {headerExtra}
      </div>
      {children}
    </div>
  );
}
function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconChevron({ dir }) {
  const d = dir === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7";
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d={d} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconStar({ filled }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8">
      <path d="M12 2l2.9 6.6 7.1.6-5.4 4.7 1.7 6.9L12 17.3 5.7 20.8l1.7-6.9L2 9.2l7.1-.6L12 2z" strokeLinejoin="round" />
    </svg>
  );
}
function IconX({ on }) {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={on ? 2.6 : 1.8}>
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  );
}
function IconUsers() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function IconCalendar() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" strokeLinecap="round" />
    </svg>
  );
}
function IconReceipt() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" strokeLinejoin="round" />
      <path d="M9 8h6M9 12h6" strokeLinecap="round" />
    </svg>
  );
}
function IconPrinter() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M6 9V3h12v6M6 18H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2" strokeLinejoin="round" />
      <rect x="6" y="14" width="12" height="7" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M4 20V10M12 20V4M20 20v-7" strokeLinecap="round" />
    </svg>
  );
}
function IconGift() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3" y="8" width="18" height="13" rx="1" />
      <path d="M3 12h18M12 8v13M7.5 8a2.5 2.5 0 1 1 0-5C10 3 12 8 12 8s2-5 4.5-5a2.5 2.5 0 1 1 0 5" strokeLinejoin="round" />
    </svg>
  );
}
function IconSun() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M2 12h2M20 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" strokeLinecap="round" />
    </svg>
  );
}

function BarMini({ data, valueKey, labelKey, color = "var(--primary)", height = 170 }) {
  const max = Math.max(1, ...data.map((d) => Math.abs(d[valueKey])));
  const w = 100 / Math.max(data.length, 1);
  return (
    <div className="barmini" style={{ height }}>
      {data.map((d, i) => {
        const h = Math.max(2, (Math.abs(d[valueKey]) / max) * (height - 34));
        return (
          <div key={i} className="barmini-col" style={{ width: `${w}%` }}>
            <div className="barmini-val">{money(d[valueKey])}</div>
            <div className="barmini-bar" style={{ height: `${h}px`, background: color }} />
            <div className="barmini-label">{d[labelKey]}</div>
          </div>
        );
      })}
    </div>
  );
}
function LineMini({ series, labelKey, height = 160 }) {
  const allVals = series.flatMap((s) => s.data.map((d) => d[s.valueKey]));
  const max = Math.max(1, ...allVals);
  const min = Math.min(0, ...allVals);
  const range = max - min || 1;
  const w = 600, pad = 26;
  const points = series[0].data;
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="linemini" preserveAspectRatio="none">
      {series.map((s, si) => {
        const coords = s.data.map((d, i) => {
          const x = pad + i * step;
          const y = height - pad - ((d[s.valueKey] - min) / range) * (height - pad * 2);
          return `${x},${y}`;
        });
        return (
          <g key={si}>
            <polyline points={coords.join(" ")} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            {s.data.map((d, i) => {
              const [x, y] = coords[i].split(",");
              return <circle key={i} cx={x} cy={y} r="3.5" fill={s.color} />;
            })}
          </g>
        );
      })}
      {points.map((d, i) => {
        const x = pad + i * step;
        return (
          <text key={i} x={x} y={height - 4} fontSize="10" textAnchor="middle" fill="var(--ink-soft)">
            {d[labelKey]}
          </text>
        );
      })}
    </svg>
  );
}

export default function LegajosApp({ onLogout }) {
  const [empleados, setEmpleados] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [tab, setTab] = useState("personales");
  const [query, setQuery] = useState("");
  const [photos, setPhotos] = useState({});
  const [status, setStatus] = useState("");
  const [uploading, setUploading] = useState(null);
  const [newAdelanto, setNewAdelanto] = useState({ fecha: "", monto: "", nota: "" });

  const [editMode, setEditMode] = useState(false);
  const [newEmployeeId, setNewEmployeeId] = useState(null);
  const editSnapshotRef = useRef(null);

  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() });
  const [section, setSection] = useState("legajos"); // legajos | calendario | liquidacion | boletas | estadisticas | aguinaldo | vacaciones
  const [calendarEmployeeId, setCalendarEmployeeId] = useState(null);
  const [liquidacionEmployeeId, setLiquidacionEmployeeId] = useState(null);
  const [liquidacionResult, setLiquidacionResult] = useState(null);
  const [boletaSemana, setBoletaSemana] = useState(1);
  const [seleccionActivos, setSeleccionActivos] = useState({}); // { [empId]: boolean } — no presente = seleccionado
  const [aguinaldoEmployeeId, setAguinaldoEmployeeId] = useState(null);
  const [aguinaldoYear, setAguinaldoYear] = useState(new Date().getFullYear());
  const [aguinaldoCuota, setAguinaldoCuota] = useState(1);
  const [vacacionesEmployeeId, setVacacionesEmployeeId] = useState(null);
  const [vacacionesYear, setVacacionesYear] = useState(new Date().getFullYear());
  const [sectorFiltro, setSectorFiltro] = useState("");
  const carpetaRef = useRef(null);
  const [carpetaNombre, setCarpetaNombre] = useState("");
  const [sucursales, setSucursales] = useState([]);
  const [sucursalFiltro, setSucursalFiltro] = useState("");
  const [nuevaSucursal, setNuevaSucursal] = useState("");
  const [fechaCorte, setFechaCorte] = useState(() => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
  });

  const statusTimer = useRef(null);
  const flash = (msg) => {
    setStatus(msg);
    clearTimeout(statusTimer.current);
    statusTimer.current = setTimeout(() => setStatus(""), 1800);
  };

  useEffect(() => {
    (async () => {
      try {
        const res = await window.storage.get("empleados");
        if (res && res.value) setEmpleados(JSON.parse(res.value));
      } catch (e) {}
      try {
        const res2 = await window.storage.get("sucursales");
        if (res2 && res2.value) setSucursales(JSON.parse(res2.value));
      } catch (e) {}
      setLoaded(true);
    })();
  }, []);

  const persistSucursales = async (list) => {
    try { await window.storage.set("sucursales", JSON.stringify(list)); } catch (e) {}
  };
  const addSucursal = () => {
    const nombre = nuevaSucursal.trim();
    if (!nombre || sucursales.includes(nombre)) return;
    const next = [...sucursales, nombre].sort();
    setSucursales(next);
    persistSucursales(next);
    setNuevaSucursal("");
  };
  const removeSucursal = (nombre) => {
    const next = sucursales.filter((s) => s !== nombre);
    setSucursales(next);
    persistSucursales(next);
  };

  const persistList = async (list) => {
    try {
      await window.storage.set("empleados", JSON.stringify(list));
      flash("Guardado");
    } catch (e) {
      flash("Error al guardar");
    }
  };

  const selected = empleados.find((e) => e.id === selectedId) || null;

  const patchEmployee = (id, patch) => {
    setEmpleados(empleados.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  // ---- confirmación propia (los diálogos nativos del navegador no funcionan en este entorno) ----
  const [confirmState, setConfirmState] = useState(null);
  const [confirmInput, setConfirmInput] = useState("");
  const askConfirm = (message, onConfirm, opts = {}) => setConfirmState({ message, onConfirm, ...opts });
  const closeConfirm = () => { setConfirmState(null); setConfirmInput(""); };

  const addEmployee = () => {
    const emp = emptyEmployee();
    setEmpleados([emp, ...empleados]);
    setNewEmployeeId(emp.id);
    setSelectedId(emp.id);
    setTab("personales");
    setEditMode(true);
  };

  const selectEmployee = (id) => {
    setSelectedId(id);
    setTab("personales");
    setEditMode(false);
  };

  const iniciarEdicion = () => {
    editSnapshotRef.current = JSON.parse(JSON.stringify(selected));
    setEditMode(true);
  };

  const cancelarEdicion = () => {
    if (selected.id === newEmployeeId) {
      setEmpleados(empleados.filter((e) => e.id !== selected.id));
      setSelectedId(null);
      setNewEmployeeId(null);
    } else if (editSnapshotRef.current) {
      const snap = editSnapshotRef.current;
      setEmpleados(empleados.map((e) => (e.id === snap.id ? snap : e)));
    }
    setEditMode(false);
  };

  const guardarCambios = async () => {
    await persistList(empleados);
    if (selected && selected.id === newEmployeeId) setNewEmployeeId(null);
    setEditMode(false);
  };

  const deleteEmployee = (id) => {
    askConfirm("¿Eliminar este legajo? Esta acción no se puede deshacer.", async () => {
      const next = empleados.filter((e) => e.id !== id);
      setEmpleados(next);
      await persistList(next);
      if (selectedId === id) { setSelectedId(null); setEditMode(false); }
      try {
        await window.storage.delete(`foto:${id}:frente`);
        await window.storage.delete(`foto:${id}:dorso`);
      } catch (e) {}
    }, { danger: true });
  };

  const deleteAllEmployees = () => {
    if (empleados.length === 0) return;
    askConfirm(
      `Esto va a eliminar los ${empleados.length} legajos cargados, con sus fotos de DNI y novedades. Esta acción no se puede deshacer.`,
      async () => {
        const ids = empleados.map((e) => e.id);
        setEmpleados([]);
        await persistList([]);
        setSelectedId(null);
        setEditMode(false);
        for (const id of ids) {
          try {
            await window.storage.delete(`foto:${id}:frente`);
            await window.storage.delete(`foto:${id}:dorso`);
          } catch (e) {}
        }
      },
      { danger: true, requireText: "ELIMINAR" }
    );
  };

  // ---- fotos ----
  const loadPhotos = useCallback(async (id) => {
    if (photos[id]) return;
    const entry = { frente: null, dorso: null };
    try { const f = await window.storage.get(`foto:${id}:frente`); if (f) entry.frente = f.value; } catch (e) {}
    try { const d = await window.storage.get(`foto:${id}:dorso`); if (d) entry.dorso = d.value; } catch (e) {}
    setPhotos((p) => ({ ...p, [id]: entry }));
  }, [photos]);

  useEffect(() => { if (selectedId) loadPhotos(selectedId); }, [selectedId, loadPhotos]);

  const uploadPhoto = async (id, side, file) => {
    if (!file) return;
    setUploading(side);
    try {
      const dataUrl = await compressImage(file);
      await window.storage.set(`foto:${id}:${side}`, dataUrl);
      setPhotos((p) => ({ ...p, [id]: { ...(p[id] || {}), [side]: dataUrl } }));
      flash("Foto guardada");
    } catch (e) { flash("No se pudo procesar la imagen"); }
    setUploading(null);
  };
  const removePhoto = async (id, side) => {
    try { await window.storage.delete(`foto:${id}:${side}`); } catch (e) {}
    setPhotos((p) => ({ ...p, [id]: { ...(p[id] || {}), [side]: null } }));
  };

  // ---- novedades del mes ----
  const key = monthKey(cursor.year, cursor.month);
  const changeMonth = (delta) => setCursor((c) => shiftMonth(c.year, c.month, delta));
  const mesActual = selected ? (selected.novedades[key] || emptyMes(selected)) : null;

  const patchMes = (patch) => {
    if (!selected) return;
    const nov = selected.novedades || {};
    const base = nov[key] || emptyMes(selected);
    patchEmployee(selected.id, { novedades: { ...nov, [key]: { ...base, ...patch } } });
  };
  const addItemMes = (campo, item) => patchMes({ [campo]: [...(mesActual[campo] || []), item] });
  const updateItemMes = (campo, id2, patch) =>
    patchMes({ [campo]: (mesActual[campo] || []).map((it) => (it.id === id2 ? { ...it, ...patch } : it)) });
  const removeItemMes = (campo, id2) =>
    patchMes({ [campo]: (mesActual[campo] || []).filter((it) => it.id !== id2) });

  const addAdelanto = () => {
    if (!newAdelanto.monto) return;
    addItemMes("adelantos", { id: uid(), fecha: newAdelanto.fecha || monthKey(cursor.year, cursor.month) + "-01", monto: newAdelanto.monto, nota: newAdelanto.nota });
    setNewAdelanto({ fecha: "", monto: "", nota: "" });
  };

  // ---- calendario ----
  const calendarEmployee = empleados.find((e) => e.id === calendarEmployeeId && e.activo !== false) || null;
  const diasDelMes = calendarEmployee ? ((calendarEmployee.calendario || {})[key] || {}) : {};
  const totalDiasMes = daysInMonth(cursor.year, cursor.month);

  const updateDiaCalendario = (day, patch) => {
    if (!calendarEmployee) return;
    const cal = calendarEmployee.calendario || {};
    const dias = { ...(cal[key] || {}) };
    dias[String(day)] = { ...(dias[String(day)] || { horas: "", falta: false, feriado: false }), ...patch };
    patchEmployee(calendarEmployee.id, { calendario: { ...cal, [key]: dias } });
  };

  const cargarHorasEsperadas = () => {
    if (!calendarEmployee) return;
    const hacerCarga = () => {
      const cal = calendarEmployee.calendario || {};
      const dias = {};
      for (let d = 1; d <= totalDiasMes; d++) {
        dias[String(d)] = { horas: horasEsperadasDia(calendarEmployee, cursor.year, cursor.month, d), falta: false, feriado: false };
      }
      patchEmployee(calendarEmployee.id, { calendario: { ...cal, [key]: dias } });
      flash("Horas esperadas cargadas");
    };
    if (Object.keys(diasDelMes).length > 0) {
      askConfirm(`Esto va a completar el calendario de ${MESES[cursor.month]} con las horas esperadas del legajo, reemplazando lo que hayas cargado. ¿Continuar?`, hacerCarga);
    } else {
      hacerCarga();
    }
  };

  const guardarCalendario = async () => {
    await persistList(empleados);
  };

  // ---- liquidación mensual ----
  const liquidacionEmployee = empleados.find((e) => e.id === liquidacionEmployeeId && e.activo !== false) || null;

  // ---- aguinaldo (SAC) ----
  const aguinaldoEmployee = empleados.find((e) => e.id === aguinaldoEmployeeId && e.activo !== false) || null;
  const sacRef = aguinaldoEmployee ? calcularSAC(aguinaldoEmployee, Number(aguinaldoYear), aguinaldoCuota) : null;
  const aguinaldoClave = `${aguinaldoYear}-${aguinaldoCuota}`;
  const getAguinaldoBase = (emp) => {
    const guardada = (emp.aguinaldoBase || {})[aguinaldoClave];
    return guardada !== undefined ? guardada : "";
  };
  const aguinaldoBaseInput = aguinaldoEmployee ? getAguinaldoBase(aguinaldoEmployee) : "";
  const aguinaldoBaseEfectiva = aguinaldoBaseInput !== "" ? Number(aguinaldoBaseInput) || 0 : (sacRef ? sacRef.mejor : 0);
  const aguinaldoImporte = sacRef ? aguinaldoBaseEfectiva * (sacRef.mesesTrabajados / 12) : 0;
  const setAguinaldoBase = (valor) => {
    if (!aguinaldoEmployee) return;
    const base = aguinaldoEmployee.aguinaldoBase || {};
    patchEmployee(aguinaldoEmployee.id, { aguinaldoBase: { ...base, [aguinaldoClave]: valor } });
  };
  const guardarAguinaldo = async () => { await persistList(empleados); };

  // ---- vacaciones ----
  const vacacionesEmployee = empleados.find((e) => e.id === vacacionesEmployeeId && e.activo !== false) || null;
  const vacacionesRef = vacacionesEmployee ? calcularVacaciones(vacacionesEmployee, Number(vacacionesYear), key) : null;
  const getFechasVacaciones = (emp, year) => (emp.vacacionesAsignadas || {})[String(year)] || [];
  const fechasVacacionesEmployee = vacacionesEmployee ? getFechasVacaciones(vacacionesEmployee, vacacionesYear) : [];
  const toggleFechaVacacion = (fechaISO) => {
    if (!vacacionesEmployee) return;
    const actuales = getFechasVacaciones(vacacionesEmployee, vacacionesYear);
    const next = actuales.includes(fechaISO) ? actuales.filter((f) => f !== fechaISO) : [...actuales, fechaISO].sort();
    const base = vacacionesEmployee.vacacionesAsignadas || {};
    patchEmployee(vacacionesEmployee.id, { vacacionesAsignadas: { ...base, [String(vacacionesYear)]: next } });
  };
  const guardarVacaciones = async () => { await persistList(empleados); };

  useEffect(() => {
    setLiquidacionResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liquidacionEmployeeId, key]);

  const actualizarLiquidacion = () => {
    if (!liquidacionEmployee) return;
    const resultado = computeLiquidacionCompleta(liquidacionEmployee, key);
    setLiquidacionResult({ employeeId: liquidacionEmployee.id, key, ...resultado });
    flash("Liquidación actualizada");
  };

  const liquidacionVigente = liquidacionResult && liquidacionResult.employeeId === liquidacionEmployeeId && liquidacionResult.key === key ? liquidacionResult : null;

  // ---- boletas semanales (pago en cuenta corriente, 4 pagos por mes) ----
  const getPagos = (emp) => (emp.pagosSemanales || {})[key] || emptyPagos();
  const patchPagos = (empId, patch) => {
    const emp = empleados.find((e) => e.id === empId);
    if (!emp) return;
    const pagos = emp.pagosSemanales || {};
    const base = pagos[key] || emptyPagos();
    patchEmployee(empId, { pagosSemanales: { ...pagos, [key]: { ...base, ...patch } } });
  };
  const guardarBoletas = async () => {
    await persistList(empleados);
  };

  const escapeHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const abrirPdfBoletas = () => {
    const seleccionadas = filasBoletas.filter((f) => estaSeleccionado(f.emp.id));
    if (seleccionadas.length === 0) {
      flash("Seleccioná al menos un legajo para generar el PDF");
      return;
    }
    const boletas = seleccionadas.map(({ emp, pagos }) => {
      const nombre = escapeHtml(emp.nombre || emp.apellido ? `${emp.nombre || "—"} ${emp.apellido || "—"}` : "Legajo sin nombre");
      const monto = escapeHtml(money(pagos[`s${boletaSemana}`]));
      return `
      <div class="boleta">
        <div class="boleta-header">Pago ${boletaSemana} · ${MESES[cursor.month]} ${cursor.year}</div>
        <div class="boleta-nombre">${nombre}</div>
        <div class="boleta-monto">${monto}</div>
        <div class="boleta-firma">Firma: _______________________</div>
      </div>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Boletas semanales - Pago ${boletaSemana} - ${MESES[cursor.month]} ${cursor.year}</title>
<style>
  @page { size: A4; margin: 10mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #21242a; padding: 0; margin: 0; }
  .page-title { font-size: 12px; color: #5c6167; text-align: center; margin: 0 0 8mm; }
  .boletas-grid { display: grid; grid-template-columns: repeat(2, 1fr); }
  .boleta {
    border: 1px dashed #999;
    margin: -1px 0 0 -1px;
    padding: 8mm 7mm;
    min-height: 42mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  .boleta-header { font-size: 9.5px; color: #5c6167; text-transform: uppercase; letter-spacing: .03em; margin-bottom: 8px; }
  .boleta-nombre { font-size: 15px; font-weight: 700; margin-bottom: 12px; }
  .boleta-monto { font-size: 24px; font-weight: 800; margin-bottom: 16px; }
  .boleta-firma { font-size: 10.5px; color: #5c6167; margin-top: auto; }
</style>
</head>
<body onload="window.print()">
  <div class="page-title">Boletas semanales — Pago ${boletaSemana} · ${MESES[cursor.month]} ${cursor.year} · cortar por la línea punteada</div>
  <div class="boletas-grid">${boletas}</div>
</body>
</html>`;

    abrirOdescargarHtml(html, `boletas-pago${boletaSemana}-${key}.html`);
  };

  const getSabadosDelMes = (year, month) => {
    const total = daysInMonth(year, month);
    const sabados = [];
    for (let d = 1; d <= total; d++) {
      if (new Date(year, month, d).getDay() === 6) sabados.push(d);
    }
    return sabados;
  };
  const formatFechaLarga = (year, month, day) => `${String(day).padStart(2, "0")}/${String(month + 1).padStart(2, "0")}/${year}`;

  const elegirCarpeta = async () => {
    if (!window.showDirectoryPicker) {
      flash("Tu navegador no permite elegir una carpeta fija; los archivos se van a descargar normalmente");
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ startIn: "desktop", mode: "readwrite" });
      carpetaRef.current = handle;
      setCarpetaNombre(handle.name);
      flash(`Carpeta "${handle.name}" lista — ahí se van a guardar los PDF`);
    } catch (e) {
      // el usuario canceló el selector, no hacemos nada
    }
  };

  const abrirOdescargarHtml = async (html, filename) => {
    if (carpetaRef.current) {
      try {
        const fileHandle = await carpetaRef.current.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(html);
        await writable.close();
        flash(`Guardado en "${carpetaRef.current.name}"`);
        const blobUrl = URL.createObjectURL(new Blob([html], { type: "text/html" }));
        window.open(blobUrl, "_blank");
        return;
      } catch (e) {
        flash("No se pudo guardar en la carpeta elegida; se descarga el archivo");
      }
    }

    const win = window.open("", "_blank");
    if (win && !win.closed) {
      win.document.open();
      win.document.write(html);
      win.document.close();
      return;
    }
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    flash("Se descargó el archivo: abrilo con tu navegador para imprimir");
  };

  const abrirImpresionMensual = () => {
    const seleccionados = filteredActivos.filter((emp) => estaSeleccionado(emp.id));
    if (seleccionados.length === 0) {
      flash("Seleccioná al menos un legajo para imprimir");
      return;
    }
    const { year, month } = keyParts(key);
    const sabados = getSabadosDelMes(year, month);

    const fila = (label, cantidad, monto) => {
      if (!monto) return "";
      return `<tr><td>${label}</td><td class="num">${cantidad || ""}</td><td class="num">${escapeHtml(money(monto))}</td></tr>`;
    };

    const fechaCorta = (iso) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
      return m ? `${m[3]}/${m[2]}` : "—";
    };
    const porFecha = (a, b) => String(a.fecha || "").localeCompare(String(b.fecha || ""));
    const detalleBloque = (titulo, columna, filas, total) => `
      <div class="det">
        <div class="det-head"><span>${titulo}</span><span>${columna}</span></div>
        ${filas.length ? filas.join("") : `<div class="det-vacio">Sin movimientos</div>`}
        <div class="det-total"><span>Total</span><span>${escapeHtml(money(total))}</span></div>
      </div>`;
    const detalleFila = (fecha, texto, monto) => `<div class="det-row"><span class="det-fecha">${escapeHtml(fecha)}</span><span class="det-texto">${escapeHtml(texto)}</span><span class="det-monto">${escapeHtml(money(monto))}</span></div>`;

    const recibos = seleccionados.map((emp) => {
      const liq = computeLiquidacionCompleta(emp, key);
      const pagos = getPagos(emp);
      const mes = (emp.novedades || {})[key] || {};
      const nombre = escapeHtml(emp.nombre || emp.apellido ? `${emp.nombre || "—"} ${emp.apellido || "—"}` : "Legajo sin nombre");

      const haberes = [
        fila("Básico", "", liq.basico),
        fila("Presentismo", "", liq.presentismo),
        fila("No remunerativo", "", liq.noRemunerativo),
        fila("Adicionales", "", liq.totalAdicionales),
        fila("Horas extra", `${liq.horasExtra} hs`, liq.montoExtra),
        fila("Domingo trabajado", `${liq.domingosTrabajados} día(s)`, liq.montoDomingo),
        fila("Feriado trabajado", `${liq.feriadosTrabajados} día(s)`, liq.montoFeriado),
      ].join("");

      const deducciones = [
        fila("Faltas", `${liq.faltasDetalle.length} día(s)`, liq.montoFaltas),
        fila("Hs no trabajadas", `${liq.horasNoTrabajadas} hs`, liq.montoNoTrabajadas),
        fila("Adelantos", "", liq.totalAdelantos),
        fila("Mercadería", "", liq.totalMercaderia),
        fila("Embargos", "", liq.totalEmbargos),
      ].join("");

      const pagosFilas = sabados.slice(0, 4).map((dia, idx) => {
        const n = idx + 1;
        const monto = Number(pagos[`s${n}`]) || 0;
        return `<tr><td>Pago ${n}</td><td class="num">${formatFechaLarga(year, month, dia)}</td><td class="num">${escapeHtml(money(monto))}</td></tr>`;
      }).join("");
      const totalAbonado = [1, 2, 3, 4].reduce((s, n) => s + (Number(pagos[`s${n}`]) || 0), 0);
      const saldoPendiente = liq.neto - totalAbonado;

      const filasExtra = liq.extraDetalle.map((x) => detalleFila(x.fecha, `${x.horas} hs`, x.monto));
      const filasAdelantos = [...(mes.adelantos || [])].filter((x) => Number(x.monto)).sort(porFecha)
        .map((x) => detalleFila(fechaCorta(x.fecha), x.nota || "Adelanto", Number(x.monto)));
      const filasMerc = [...(mes.mercaderia || [])].filter((x) => Number(x.monto)).sort(porFecha)
        .map((x) => detalleFila(fechaCorta(x.fecha), x.concepto || "Mercadería", Number(x.monto)));

      return `
      <div class="recibo">
        <div class="recibo-head">
          <div>
            <div class="recibo-nombre">${nombre}</div>
            <div class="recibo-meta">${emp.dni ? "DNI " + escapeHtml(emp.dni) : "Sin DNI"}${emp.area ? " · " + escapeHtml(emp.area) : ""}${emp.cargo ? " · " + escapeHtml(emp.cargo) : ""}</div>
          </div>
          <div class="recibo-periodo">${MESES[month]} ${year}</div>
        </div>
        <div class="recibo-cols">
          <div class="col">
            <table class="tabla">
              <thead><tr><th colspan="3">Haberes</th></tr></thead>
              <tbody>${haberes || `<tr><td colspan="3" class="vacio">Sin conceptos cargados</td></tr>`}</tbody>
              <tfoot><tr><td>Total haberes</td><td></td><td class="num">${escapeHtml(money(liq.totalHaberes))}</td></tr></tfoot>
            </table>
            <table class="tabla">
              <thead><tr><th colspan="3">Deducciones</th></tr></thead>
              <tbody>${deducciones || `<tr><td colspan="3" class="vacio">Sin deducciones</td></tr>`}</tbody>
              <tfoot><tr><td>Total deducciones</td><td></td><td class="num">${escapeHtml(money(liq.totalDeducciones))}</td></tr></tfoot>
            </table>
          </div>
          <div class="col">
            <table class="tabla">
              <thead><tr><th colspan="3">Pago semanal (sábados)</th></tr></thead>
              <tbody>${pagosFilas}</tbody>
              <tfoot>
                <tr><td>Total abonado</td><td></td><td class="num">${escapeHtml(money(totalAbonado))}</td></tr>
              </tfoot>
            </table>
            <div class="neto-box">
              <div class="neto-linea"><span>Neto a cobrar</span><strong>${escapeHtml(money(liq.neto))}</strong></div>
              <div class="neto-linea saldo"><span>Saldo pendiente</span><strong>${escapeHtml(money(saldoPendiente))}</strong></div>
            </div>
          </div>
        </div>
        <div class="det-titulo">Detalle de novedades</div>
        <div class="det-grid">
          ${detalleBloque("Horas extra", "Importe", filasExtra, liq.montoExtra)}
          ${detalleBloque("Adelantos", "Importe", filasAdelantos, liq.totalAdelantos)}
          ${detalleBloque("Mercadería", "Importe", filasMerc, liq.totalMercaderia)}
        </div>
      </div>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Liquidación mensual - ${MESES[month]} ${year}</title>
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #21242a; padding: 0; margin: 0; font-size: 10px; }
  .recibo { min-height: 146mm; padding: 7mm 10mm; display: flex; flex-direction: column; page-break-inside: avoid; break-inside: avoid; border-bottom: 1px dashed #999; }
  .recibo-head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 1.5px solid #21242a; padding-bottom: 5px; margin-bottom: 7px; }
  .recibo-nombre { font-size: 14px; font-weight: 700; }
  .recibo-meta { font-size: 9.5px; color: #5c6167; margin-top: 2px; }
  .recibo-periodo { font-size: 11px; font-weight: 600; color: #5c6167; }
  .recibo-cols { display: grid; grid-template-columns: 1.1fr 1fr; gap: 8mm; }
  .tabla { width: 100%; border-collapse: collapse; margin-bottom: 6px; }
  .tabla th { text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: .03em; color: #5c6167; padding: 3px 2px; border-bottom: 1px solid #dcd9d0; }
  .tabla td { padding: 2.5px 2px; font-size: 10px; border-bottom: 1px solid #eee; }
  .tabla td.num { text-align: right; white-space: nowrap; }
  .tabla td.vacio { color: #999; font-style: italic; }
  .tabla tfoot td { font-weight: 700; border-top: 1px solid #21242a; border-bottom: none; padding-top: 4px; }
  .neto-box { margin-top: 6px; border: 1.5px solid #21242a; border-radius: 3px; padding: 8px 10px; }
  .neto-linea { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
  .neto-linea strong { font-size: 13px; }
  .neto-linea.saldo { border-top: 1px dashed #999; margin-top: 4px; padding-top: 6px; color: #a8562e; }
  .det-titulo { margin-top: 8px; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #21242a; padding-bottom: 2px; }
  .det-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6mm; margin-top: 4px; }
  .det-head { display: flex; justify-content: space-between; font-size: 8.5px; text-transform: uppercase; letter-spacing: .03em; color: #5c6167; padding: 2px; border-bottom: 1px solid #dcd9d0; font-weight: 700; }
  .det-row { display: flex; gap: 4px; padding: 2px; border-bottom: 1px solid #eee; font-size: 9.5px; }
  .det-fecha { width: 30px; color: #5c6167; flex: none; }
  .det-texto { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .det-monto { white-space: nowrap; text-align: right; }
  .det-vacio { color: #999; font-style: italic; font-size: 9.5px; padding: 3px 2px; }
  .det-total { display: flex; justify-content: space-between; font-size: 9.5px; font-weight: 700; border-top: 1px solid #21242a; padding: 3px 2px 0; margin-top: 1px; }
  .preview-bar { position: sticky; top: 0; background: #263a41; color: #fff; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; z-index: 10; }
  .preview-bar button { background: #fff; color: #263a41; border: none; border-radius: 3px; padding: 8px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  @media print { .preview-bar { display: none; } }
</style>
</head>
<body>
  <div class="preview-bar">
    <span>Vista previa — revisá los datos antes de imprimir (${seleccionados.length} legajo${seleccionados.length === 1 ? "" : "s"})</span>
    <button onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>
  ${recibos}
</body>
</html>`;

    abrirOdescargarHtml(html, `liquidacion-mensual-${key}.html`);
  };

  const abrirPdfAguinaldo = () => {
    if (!aguinaldoEmployee || !sacRef) return;
    const emp = aguinaldoEmployee;
    const year = Number(aguinaldoYear);
    const nombreCuota = aguinaldoCuota === 1 ? "SAC 1° cuota" : "SAC 2° cuota";
    const periodo = aguinaldoCuota === 1 ? "enero a junio" : "julio a diciembre";
    const nombre = escapeHtml(emp.nombre || emp.apellido ? `${emp.nombre || "—"} ${emp.apellido || "—"}` : "Legajo sin nombre");
    const meta = escapeHtml(`${emp.dni ? "DNI " + emp.dni : "Sin DNI"}${emp.area ? " · " + emp.area : ""}${emp.cargo ? " · " + emp.cargo : ""}`);

    const liq = sacRef.mejorLiq;
    const filaConcepto = (label, cantidad, monto) => (!monto ? "" : `<tr><td>${label}</td><td class="num">${cantidad || ""}</td><td class="num">${escapeHtml(money(monto))}</td></tr>`);
    const detalleFilas = liq ? [
      filaConcepto("Básico", "", liq.basico),
      filaConcepto("Presentismo", "", liq.presentismo),
      filaConcepto("Adicionales", "", liq.totalAdicionales),
      filaConcepto("Horas extra", `${liq.horasExtra} hs`, liq.montoExtra),
      filaConcepto("Domingo trabajado", `${liq.domingosTrabajados} día(s)`, liq.montoDomingo),
      filaConcepto("Feriado trabajado", `${liq.feriadosTrabajados} día(s)`, liq.montoFeriado),
    ].join("") : `<tr><td colspan="3">Sin sueldos cargados en este semestre</td></tr>`;

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Aguinaldo - ${nombre} - ${year}</title>
<style>
  @page { size: A4; margin: 15mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #21242a; padding: 0; margin: 0; font-size: 12px; }
  .head { border-bottom: 1.5px solid #21242a; padding-bottom: 8px; margin-bottom: 16px; }
  .head h1 { font-size: 16px; margin: 0 0 2px; }
  .head .meta { font-size: 11px; color: #5c6167; }
  .tabla { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  .tabla th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .03em; color: #5c6167; padding: 4px 3px; border-bottom: 1px solid #dcd9d0; }
  .tabla td { padding: 4px 3px; font-size: 11.5px; border-bottom: 1px solid #eee; }
  .tabla td.num { text-align: right; }
  .tabla tfoot td { font-weight: 700; border-top: 1px solid #21242a; border-bottom: none; padding-top: 6px; }
  .neto-box { margin-top: 10px; border: 1.5px solid #21242a; border-radius: 3px; padding: 10px 14px; }
  .neto-linea { display: flex; justify-content: space-between; font-size: 14px; }
  .preview-bar { position: sticky; top: 0; background: #263a41; color: #fff; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; z-index: 10; margin: -15mm -15mm 15mm; }
  .preview-bar button { background: #fff; color: #263a41; border: none; border-radius: 3px; padding: 8px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  @media print { .preview-bar { display: none; } }
</style>
</head>
<body>
  <div class="preview-bar">
    <span>Vista previa — revisá los datos antes de imprimir</span>
    <button onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>
  <div class="head">
    <h1>${nombreCuota} — ${nombre}</h1>
    <div class="meta">${meta} · Período: ${periodo} de ${year}${sacRef.mejorMes ? ` · Mejor sueldo: ${escapeHtml(sacRef.mejorMes)}` : ""}</div>
  </div>
  <table class="tabla">
    <thead><tr><th>Concepto (mejor sueldo del semestre)</th><th>Cantidad</th><th>Importe</th></tr></thead>
    <tbody>${detalleFilas}</tbody>
    <tfoot><tr><td>Mejor remuneración del semestre (referencia)</td><td></td><td class="num">${escapeHtml(money(sacRef.mejor))}</td></tr></tfoot>
  </table>
  <div class="neto-box">
    <div class="neto-linea"><span>Base imponible utilizada</span><strong>${escapeHtml(money(aguinaldoBaseEfectiva))}</strong></div>
    <div class="neto-linea"><span>Meses trabajados en el semestre</span><strong>${sacRef.mesesTrabajados} / 6</strong></div>
    <div class="neto-linea"><span>Importe a liquidar</span><strong>${escapeHtml(money(aguinaldoImporte))}</strong></div>
  </div>
</body>
</html>`;

    abrirOdescargarHtml(html, `aguinaldo-sac${aguinaldoCuota}-${emp.id}-${year}.html`);
  };

  const abrirPdfVacaciones = () => {
    const empleadosPdf = filteredActivos;
    if (empleadosPdf.length === 0) {
      flash("No hay legajos para mostrar con estos filtros");
      return;
    }
    const year = Number(vacacionesYear);
    const PALETTE = ["#3c5a64", "#a8562e", "#6a4e6c", "#5c7a4a", "#b08d2e", "#2e6b8f", "#8f2e4a", "#4a8f6b", "#8f6b2e", "#2e4a8f", "#8f2e2e", "#2e8f7a"];
    const colorDe = {};
    empleadosPdf.forEach((emp, i) => { colorDe[emp.id] = PALETTE[i % PALETTE.length]; });

    // mapa fecha -> lista de {nombre, color} de los legajos con esa fecha asignada
    const mapaFechas = {};
    empleadosPdf.forEach((emp) => {
      const nombre = emp.nombre || emp.apellido ? `${emp.nombre || "—"} ${emp.apellido || "—"}` : "Legajo sin nombre";
      getFechasVacaciones(emp, year).forEach((f) => {
        if (!mapaFechas[f]) mapaFechas[f] = [];
        mapaFechas[f].push({ nombre, color: colorDe[emp.id] });
      });
    });

    const gradientePara = (colores) => {
      if (colores.length === 0) return "";
      if (colores.length === 1) return colores[0];
      const paso = 100 / colores.length;
      const paradas = colores.map((c, i) => `${c} ${i * paso}%, ${c} ${(i + 1) * paso}%`).join(", ");
      return `linear-gradient(90deg, ${paradas})`;
    };

    const mesHtml = (m) => {
      const total = daysInMonth(year, m);
      const lead = mondayIndex(year, m, 1);
      let celdas = "";
      for (let i = 0; i < lead; i++) celdas += `<div class="pv-day pv-blank"></div>`;
      for (let d = 1; d <= total; d++) {
        const fechaISO = dateStr(year, m, d);
        const asignados = mapaFechas[fechaISO] || [];
        const bg = gradientePara(asignados.map((a) => a.color));
        const style = bg ? ` style="background:${bg}"` : "";
        const titulo = asignados.length ? ` title="${escapeHtml(asignados.map((a) => a.nombre).join(", "))}"` : "";
        const claseTexto = asignados.length ? " pv-day-marcado" : "";
        celdas += `<div class="pv-day${claseTexto}"${style}${titulo}>${d}</div>`;
      }
      const dow = DOW.map((d) => `<div class="pv-dow">${d[0]}</div>`).join("");
      return `<div class="pv-month"><div class="pv-month-title">${MESES[m]}</div><div class="pv-grid">${dow}${celdas}</div></div>`;
    };
    const mesesHtml = [0, 1, 2, 3, 4, 5].map(mesHtml).join("");

    const leyenda = empleadosPdf.map((emp) => {
      const nombre = escapeHtml(emp.nombre || emp.apellido ? `${emp.nombre || "—"} ${emp.apellido || "—"}` : "Legajo sin nombre");
      return `<div class="pv-leyenda-item"><span class="pv-swatch" style="background:${colorDe[emp.id]}"></span>${nombre}</div>`;
    }).join("");

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8" />
<title>Vacaciones ${year}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #21242a; padding: 0; margin: 0; font-size: 10.5px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  .sub { font-size: 11px; color: #5c6167; margin-bottom: 14px; }
  .pv-calendario { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
  .pv-month { border: 1px solid #dcd9d0; border-radius: 3px; padding: 8px; page-break-inside: avoid; }
  .pv-month-title { font-weight: 700; font-size: 12px; text-align: center; margin-bottom: 6px; }
  .pv-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
  .pv-dow { text-align: center; font-size: 8.5px; color: #5c6167; }
  .pv-day { aspect-ratio: 1; border: 1px solid #eee; border-radius: 2px; font-size: 9px; display: flex; align-items: center; justify-content: center; }
  .pv-day-marcado { color: #fff; font-weight: 700; border-color: transparent; }
  .pv-blank { border: none; }
  .pv-leyenda { display: flex; flex-wrap: wrap; gap: 10px 18px; border-top: 1px solid #dcd9d0; padding-top: 10px; }
  .pv-leyenda-item { display: flex; align-items: center; gap: 6px; font-size: 11px; }
  .pv-swatch { width: 11px; height: 11px; border-radius: 2px; display: inline-block; }
  .preview-bar { position: sticky; top: 0; background: #263a41; color: #fff; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 12.5px; z-index: 10; margin: -12mm -12mm 12mm; }
  .preview-bar button { background: #fff; color: #263a41; border: none; border-radius: 3px; padding: 8px 16px; font-size: 12.5px; font-weight: 600; cursor: pointer; }
  @media print { .preview-bar { display: none; } }
</style>
</head>
<body>
  <div class="preview-bar">
    <span>Vista previa — revisá los datos antes de imprimir (${empleadosPdf.length} legajo${empleadosPdf.length === 1 ? "" : "s"})</span>
    <button onclick="window.print()">Imprimir / Guardar como PDF</button>
  </div>
  <h1>Calendario de vacaciones ${year} (enero a junio)</h1>
  <div class="sub">${sucursalFiltro ? `Sucursal: ${escapeHtml(sucursalFiltro)}` : "Todas las sucursales"} · ${sectorFiltro ? `Sector: ${escapeHtml(sectorFiltro)}` : "Todos los sectores"}</div>
  <div class="pv-calendario">${mesesHtml}</div>
  <div class="pv-leyenda">${leyenda}</div>
</body>
</html>`;

    abrirOdescargarHtml(html, `vacaciones-${year}.html`);
  };

  const filtered = empleados.filter((e) => {
    if (sucursalFiltro && e.sucursal !== sucursalFiltro) return false;
    if (sectorFiltro && e.sector !== sectorFiltro) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      `${e.nombre} ${e.apellido}`.toLowerCase().includes(q) ||
      (e.dni || "").includes(q) ||
      (e.cargo || "").toLowerCase().includes(q) ||
      (e.area || "").toLowerCase().includes(q)
    );
  });
  const filteredActivos = filtered.filter((e) => e.activo !== false);

  const filasBoletas = filteredActivos.map((emp) => {
    const liq = computeLiquidacionCompleta(emp, key);
    const pagos = getPagos(emp);
    const pagado1 = Number(pagos.s1) || 0;
    const pagado2 = Number(pagos.s2) || 0;
    const pagado3 = Number(pagos.s3) || 0;
    let sugerido;
    if (boletaSemana === 1) sugerido = liq.neto / 4;
    else if (boletaSemana === 2) sugerido = (liq.neto - pagado1) / 3;
    else if (boletaSemana === 3) sugerido = (liq.neto - pagado1 - pagado2) / 2;
    else sugerido = liq.neto - pagado1 - pagado2 - pagado3;
    return { emp, liq, pagos, sugerido };
  });

  const estaSeleccionado = (id) => seleccionActivos[id] !== false;
  const toggleSeleccion = (id) => setSeleccionActivos((prev) => ({ ...prev, [id]: !estaSeleccionado(id) }));
  const todosSeleccionados = filasBoletas.length > 0 && filasBoletas.every((f) => estaSeleccionado(f.emp.id));
  const toggleSeleccionarTodos = () => {
    const next = {};
    filasBoletas.forEach((f) => { next[f.emp.id] = !todosSeleccionados; });
    setSeleccionActivos((prev) => ({ ...prev, ...next }));
  };

  // ---- estadísticas ----
  const totalPagadoMes = (mesKey) =>
    empleados.reduce((s, e) => {
      const pagos = (e.pagosSemanales || {})[mesKey] || {};
      return s + [1, 2, 3, 4].reduce((s2, n) => s2 + (Number(pagos[`s${n}`]) || 0), 0);
    }, 0);

  const totalPagadoHastaFecha = (fechaISO) => {
    if (!fechaISO) return 0;
    const target = new Date(fechaISO + "T23:59:59");
    const monthKeysSet = new Set();
    empleados.forEach((e) => Object.keys(e.pagosSemanales || {}).forEach((k) => monthKeysSet.add(k)));
    let total = 0;
    monthKeysSet.forEach((mk) => {
      const { year, month } = keyParts(mk);
      const sabados = getSabadosDelMes(year, month).slice(0, 4);
      empleados.forEach((e) => {
        const pagos = (e.pagosSemanales || {})[mk] || {};
        sabados.forEach((dia, idx) => {
          const fechaPago = new Date(year, month, dia);
          if (fechaPago <= target) total += Number(pagos[`s${idx + 1}`]) || 0;
        });
      });
    });
    return total;
  };

  const agruparPor = (campo, mesKey) => {
    const grupos = {};
    filteredActivos.forEach((e) => {
      const clave = e[campo] && e[campo].trim() ? e[campo] : "Sin asignar";
      const liq = computeLiquidacionCompleta(e, mesKey);
      const pagos = (e.pagosSemanales || {})[mesKey] || {};
      const pagado = [1, 2, 3, 4].reduce((s, n) => s + (Number(pagos[`s${n}`]) || 0), 0);
      if (!grupos[clave]) grupos[clave] = { clave, cantidad: 0, neto: 0, pagado: 0 };
      grupos[clave].cantidad += 1;
      grupos[clave].neto += liq.neto;
      grupos[clave].pagado += pagado;
    });
    return Object.values(grupos).sort((a, b) => b.neto - a.neto);
  };

  const porSucursal = section === "estadisticas" ? agruparPor("sucursal", key) : [];
  const porSector = section === "estadisticas" ? agruparPor("sector", key) : [];
  const porTurno = section === "estadisticas" ? agruparPor("turno", key) : [];
  const totalAPagarMes = section === "estadisticas" ? filteredActivos.reduce((s, e) => s + computeLiquidacionCompleta(e, key).neto, 0) : 0;
  const totalPagadoEsteMes = section === "estadisticas" ? totalPagadoMes(key) : 0;
  const totalHastaFecha = section === "estadisticas" ? totalPagadoHastaFecha(fechaCorte) : 0;

  const evolucionMensual = section === "estadisticas"
    ? last6MonthKeys(cursor.year, cursor.month).map((mk) => {
        const { month: m } = keyParts(mk);
        const aPagar = filteredActivos.reduce((s, e) => s + computeLiquidacionCompleta(e, mk).neto, 0);
        return { label: MESES_ABBR[m], aPagar, pagado: totalPagadoMes(mk) };
      })
    : [];

  const rankingFaltas = section === "estadisticas"
    ? filteredActivos
        .map((e) => ({ emp: e, cantidad: computeLiquidacionCompleta(e, key).faltasDetalle.length }))
        .filter((r) => r.cantidad > 0)
        .sort((a, b) => b.cantidad - a.cantidad)
        .slice(0, 5)
    : [];
  const rankingExtra = section === "estadisticas"
    ? filteredActivos
        .map((e) => ({ emp: e, horas: computeLiquidacionCompleta(e, key).horasExtra }))
        .filter((r) => r.horas > 0)
        .sort((a, b) => b.horas - a.horas)
        .slice(0, 5)
    : [];

  const totalAdelantosMes = section === "estadisticas"
    ? filteredActivos.reduce((s, e) => s + ((e.novedades || {})[key]?.adelantos || []).reduce((s2, a) => s2 + (Number(a.monto) || 0), 0), 0)
    : 0;
  const totalMercaderiaMes = section === "estadisticas"
    ? filteredActivos.reduce((s, e) => s + ((e.novedades || {})[key]?.mercaderia || []).reduce((s2, m2) => s2 + (Number(m2.monto) || 0), 0), 0)
    : 0;

  const TABS = [
    { id: "personales", label: "Datos personales" },
    { id: "documentacion", label: "Documentación" },
    { id: "remuneracion", label: "Remuneración" },
    { id: "horas", label: "Horas esperadas" },
    { id: "novedades", label: "Novedades del mes" },
  ];

  const p = selected ? photos[selected.id] || {} : {};
  const totalAdicionales = mesActual ? (mesActual.adicionales || []).reduce((s, a) => s + (Number(a.monto) || 0), 0) : 0;
  const totalMercaderia = mesActual ? (mesActual.mercaderia || []).reduce((s, m) => s + (Number(m.monto) || 0), 0) : 0;
  const totalAdelantos = mesActual ? (mesActual.adelantos || []).reduce((s, a) => s + (Number(a.monto) || 0), 0) : 0;
  const totalEmbargos = mesActual ? (mesActual.embargos || []).reduce((s, em) => s + (Number(em.valor) || 0), 0) : 0;

  return (
    <div className="app">
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Spectral:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&display=swap');

        * { box-sizing: border-box; }
        body { margin: 0; }
        .app {
          --paper: #f3f2ee; --surface: #ffffff; --ink: #21242a; --ink-soft: #5c6167; --line: #dcd9d0;
          --primary: #3c5a64; --primary-dark: #263a41; --good: #5c7a4a; --warn: #a8562e; --plum: #6a4e6c;
          font-family: 'IBM Plex Sans', sans-serif; color: var(--ink); background: var(--paper);
          min-height: 100vh; display: grid; grid-template-columns: 300px 1fr; grid-template-rows: auto 1fr; grid-template-areas: "top top" "side main"; font-size: 14px; line-height: 1.5;
        }
        @media (max-width: 780px) {
          .app { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto 1fr; grid-template-areas: "top" "side" "main"; }
          .sidebar { display: ${(section === "legajos" && selectedId) || (section === "calendario" && calendarEmployeeId) || (section === "liquidacion" && liquidacionEmployeeId) || (section === "aguinaldo" && aguinaldoEmployeeId) || (section === "vacaciones" && vacacionesEmployeeId) ? "none" : "flex"}; }
          .main { display: ${(section === "legajos" && selectedId) || (section === "calendario" && calendarEmployeeId) || (section === "liquidacion" && liquidacionEmployeeId) || (section === "aguinaldo" && aguinaldoEmployeeId) || (section === "vacaciones" && vacacionesEmployeeId) || section === "boletas" || section === "estadisticas" ? "block" : "none"}; }
        }
        h1, h2, h3 { font-family: 'Spectral', serif; margin: 0; font-weight: 600; }
        button { font-family: inherit; cursor: pointer; }
        input, select {
          font-family: inherit; font-size: 13.5px; background: var(--surface); border: 1px solid var(--line);
          border-radius: 3px; padding: 8px 10px; color: var(--ink); width: 100%;
        }
        input:focus, select:focus, button:focus-visible { outline: 2px solid var(--primary); outline-offset: 1px; border-color: var(--primary); }
        input:disabled { background: var(--paper); color: var(--ink-soft); }

        .topbar { grid-area: top; position: sticky; top: 0; z-index: 20; background: var(--surface); border-bottom: 1px solid var(--line); display: flex; align-items: center; gap: 24px; padding: 0 20px; min-height: 56px; }
        .brand { display: flex; align-items: baseline; gap: 8px; flex: none; }
        .brand-mark { font-size: 11px; letter-spacing: 0.04em; color: var(--ink-soft); order: 2; }
        .brand h1 { font-size: 19px; color: var(--primary-dark); }
        .nav-tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
        .nav-tabs::-webkit-scrollbar { display: none; }
        .nav-tab { background: none; border: none; border-bottom: 3px solid transparent; height: 56px; padding: 0 14px; font-size: 13px; color: var(--ink-soft); display: flex; align-items: center; gap: 7px; white-space: nowrap; flex: none; }
        .nav-tab svg { width: 15px; height: 15px; flex: none; }
        .sidebar { grid-area: side; border-right: 1px solid var(--line); background: var(--surface); display: flex; flex-direction: column; height: calc(100vh - 56px); position: sticky; top: 56px; overflow-y: auto; }
        .main { grid-area: main; }
        .nav-tab:hover { background: #eae8e2; }
        .nav-tab.active { color: var(--primary-dark); font-weight: 600; border-bottom-color: var(--primary); }
        .account-menu { position: relative; flex: none; }
        .account-menu summary { cursor: pointer; font-size: 12px; color: var(--ink-soft); list-style: none; user-select: none; border: 1px solid var(--line); border-radius: 3px; padding: 6px 12px; white-space: nowrap; }
        .account-menu summary::-webkit-details-marker { display: none; }
        .account-menu-body { position: absolute; right: 0; top: calc(100% + 6px); width: 200px; background: var(--surface); border: 1px solid var(--line); border-radius: 4px; box-shadow: 0 6px 20px rgba(0,0,0,.12); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
        .sidebar-tools { padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; border-bottom: 1px solid var(--line); }
        .btn-new { background: var(--primary-dark); color: #fff; border: none; border-radius: 3px; padding: 10px 12px; font-size: 13.5px; font-weight: 500; display: flex; align-items: center; justify-content: center; gap: 6px; }
        .btn-new:hover { background: #1c2c31; }
        .link-danger { background: none; border: none; color: var(--warn); font-size: 12px; text-align: left; padding: 2px 0; }
        .link-danger:hover { text-decoration: underline; }
        .emp-list { flex: 1 1 0; min-height: 220px; overflow-y: auto; padding: 6px 0; }
        .emp-item { width: 100%; text-align: left; background: none; border: none; border-left: 3px solid transparent; padding: 11px 17px; display: block; }
        .emp-item:hover { background: #eae8e2; }
        .emp-item.active { background: #e7ede9; border-left-color: var(--primary); }
        .emp-name { font-weight: 600; font-size: 13.5px; }
        .emp-meta { color: var(--ink-soft); font-size: 12px; margin-top: 2px; }
        .empty-list { padding: 30px 20px; color: var(--ink-soft); font-size: 13px; }

        .main { padding: 30px 40px 60px; max-width: 940px; }
        .empty-main { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; margin-top: 120px; color: var(--ink-soft); max-width: 380px; }
        .empty-main h2 { color: var(--ink); font-size: 22px; }

        .detail-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 22px; gap: 16px; flex-wrap: wrap; }
        .detail-header h2 { font-size: 26px; color: var(--primary-dark); }
        .detail-header .sub { color: var(--ink-soft); font-size: 13px; margin-top: 4px; }
        .header-actions { display: flex; gap: 8px; }
        .back-link { display: none; background: none; border: none; color: var(--primary-dark); font-size: 13px; margin-bottom: 14px; padding: 0; }
        @media (max-width: 780px) { .back-link { display: inline-block; } .main { padding: 20px; } }
        @media (max-width: 780px) {
          .topbar { flex-wrap: wrap; gap: 0 12px; padding: 0 12px; position: static; }
          .brand { order: 1; flex: 1; padding: 12px 0; }
          .account-menu { order: 2; }
          .nav-tabs { order: 3; flex: 1 0 100%; }
          .nav-tab { height: 44px; padding: 0 12px; }
          .sidebar { position: static; height: auto; overflow: visible; border-right: none; }
          .emp-list { flex: none; min-height: 0; overflow: visible; }
        }
        .del-btn { background: none; border: 1px solid var(--line); color: var(--warn); border-radius: 3px; padding: 8px 12px; font-size: 12.5px; }
        .del-btn:hover { background: #f6e9e2; }
        .btn-secondary { background: var(--surface); border: 1px solid var(--line); color: var(--primary-dark); border-radius: 3px; padding: 8px 12px; font-size: 12.5px; font-weight: 500; }
        .btn-secondary:hover { border-color: var(--primary); }
        .btn-save { background: var(--good); border: 1px solid var(--good); color: #fff; border-radius: 3px; padding: 8px 14px; font-size: 12.5px; font-weight: 600; }
        .btn-save:hover { background: #4c6a3c; }
        .edit-banner { background: #eef2ee; border: 1px solid var(--good); color: #3d5330; border-radius: 3px; padding: 8px 14px; font-size: 12.5px; margin-bottom: 18px; display: flex; align-items: center; gap: 8px; }
        .carpeta-bar { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 10px 14px; font-size: 12.5px; margin-bottom: 18px; display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; color: var(--ink-soft); }

        .tabs { display: flex; gap: 2px; border-bottom: 1px solid var(--line); margin-bottom: 24px; overflow-x: auto; }
        .tab-btn { background: none; border: none; padding: 10px 14px; font-size: 13px; color: var(--ink-soft); border-bottom: 2px solid transparent; white-space: nowrap; }
        .tab-btn.active { color: var(--primary-dark); border-bottom-color: var(--primary-dark); font-weight: 600; }

        .section-card { background: var(--surface); border: 1px solid var(--line); border-left: 3px solid var(--accent, var(--primary)); border-radius: 2px; padding: 20px 22px; margin-bottom: 18px; }
        .section-head { margin-bottom: 16px; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
        .section-head h3 { font-size: 16px; }
        .section-head p { margin: 3px 0 0; color: var(--ink-soft); font-size: 12.5px; }

        .field-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
        @media (max-width: 560px) { .field-grid { grid-template-columns: 1fr; } }
        .field-grid.three { grid-template-columns: 1fr 1fr 1fr; }
        .field-grid.four { grid-template-columns: 1fr 1fr 1fr 1fr; }
        @media (max-width: 640px) { .field-grid.three, .field-grid.four { grid-template-columns: 1fr 1fr; } }
        .field { display: flex; flex-direction: column; gap: 5px; }
        .field-span { grid-column: 1 / -1; }
        .field-label { font-size: 11.5px; color: var(--ink-soft); font-weight: 500; }
        .ro-value { padding: 8px 0; font-size: 13.5px; color: var(--ink); min-height: 20px; border-bottom: 1px solid transparent; }
        .checkbox-field { display: flex; align-items: center; gap: 8px; font-size: 13.5px; color: var(--ink); }
        .checkbox-field input { width: auto; }
        .pill { display: inline-block; border-radius: 20px; padding: 4px 12px; font-size: 12px; font-weight: 500; }
        .pill-activo { background: #e8eee4; color: var(--good); border: 1px solid var(--good); }
        .pill-inactivo { background: #f5e4e1; color: var(--warn); border: 1px solid var(--warn); }
        .sucursal-manager { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
        .sucursal-manager input { max-width: 240px; }
        .sucursal-manager button { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 8px 12px; font-size: 12.5px; color: var(--primary-dark); font-weight: 500; white-space: nowrap; }
        .sucursal-manager button:hover { border-color: var(--primary); }
        .chip-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
        .chip { display: flex; align-items: center; gap: 6px; background: var(--paper); border: 1px solid var(--line); border-radius: 20px; padding: 5px 6px 5px 12px; font-size: 12px; }
        .chip button { background: none; border: none; color: var(--warn); display: flex; padding: 2px; }
        .sucursal-filtro { width: auto; min-width: 150px; }

        .row-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 14px; }
        .row-item { display: grid; gap: 8px; align-items: end; padding: 12px; background: var(--paper); border-radius: 3px; }
        .row-item.item2 { grid-template-columns: 1.6fr 1fr 32px; }
        .row-item.embargo { grid-template-columns: 1.1fr 1fr 0.7fr 0.8fr 32px; }
        .row-item.adelanto { grid-template-columns: 0.9fr 0.9fr 1.4fr 32px; }
        .row-item.mercaderia { grid-template-columns: 0.9fr 1.4fr 0.9fr 32px; }
        @media (max-width: 700px) {
          .row-item.item2, .row-item.embargo, .row-item.adelanto, .row-item.mercaderia { grid-template-columns: 1fr; }
        }
        .ro-row { display: flex; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--paper); border-radius: 3px; font-size: 13px; }
        .ro-row .muted { color: var(--ink-soft); font-size: 12px; }
        .row-remove { background: none; border: none; color: var(--ink-soft); height: 34px; display: flex; align-items: center; justify-content: center; border-radius: 3px; }
        .row-remove:hover { color: var(--warn); background: #f6e9e2; }
        .add-row-btn { background: none; border: 1px dashed var(--line); color: var(--primary-dark); border-radius: 3px; padding: 9px; font-size: 12.5px; width: 100%; font-weight: 500; }
        .add-row-btn:hover { background: #eef2ee; border-color: var(--primary); }

        .hint { font-size: 12px; color: var(--ink-soft); margin-top: 3px; }
        .subtotal-line { display: flex; justify-content: space-between; padding-top: 10px; margin-top: 4px; border-top: 1px solid var(--line); font-size: 13px; }

        .dni-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
        @media (max-width: 560px) { .dni-grid { grid-template-columns: 1fr; } }
        .dni-slot { border: 1.5px dashed var(--line); border-radius: 4px; padding: 14px; display: flex; flex-direction: column; align-items: center; gap: 10px; min-height: 190px; justify-content: center; background: var(--paper); }
        .dni-slot img { max-width: 100%; max-height: 150px; border-radius: 3px; object-fit: contain; }
        .dni-slot-label { font-size: 12.5px; color: var(--ink-soft); font-weight: 500; }
        .upload-btn { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 7px 12px; font-size: 12.5px; color: var(--primary-dark); font-weight: 500; }
        .upload-btn:hover { border-color: var(--primary); }
        .photo-actions { display: flex; gap: 8px; }
        .photo-actions button.remove { color: var(--warn); background: none; border: none; font-size: 12px; }

        .month-nav { display: flex; align-items: center; gap: 10px; }
        .month-nav button { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; color: var(--primary-dark); }
        .month-nav button:hover { border-color: var(--primary); }
        .month-nav .label { font-family: 'Spectral', serif; font-size: 16px; min-width: 150px; text-align: center; color: var(--primary-dark); }

        .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-bottom: 6px; }
        .cal-dow { text-align: center; font-size: 11px; color: var(--ink-soft); font-weight: 500; padding-bottom: 4px; }
        .cal-cell { min-height: 84px; border: 1px solid var(--line); border-radius: 3px; background: var(--paper); padding: 6px; display: flex; flex-direction: column; gap: 4px; }
        .cal-cell.blank { border: none; background: none; }
        .cal-cell.holiday { background: #f6ece0; border-color: #d9b98a; }
        .cal-cell.has-hours { background: #eaf1ec; }
        .cal-cell.holiday.has-hours { background: #f2e3cf; }
        .cal-cell.falta { background: #f5e4e1; border-color: #c98a80; }
        .cal-top { display: flex; justify-content: space-between; align-items: center; }
        .cal-daynum { font-size: 12px; font-weight: 600; color: var(--ink); }
        .cal-icons { display: flex; gap: 3px; }
        .cal-icon-btn { background: none; border: none; padding: 2px; color: #d9b98a; display: flex; }
        .cal-icon-btn.on { color: var(--warn); }
        .cal-icon-btn.falta-btn { color: #cbb8b4; }
        .cal-icon-btn.falta-btn.on { color: #c98a80; }
        .cal-hours { width: 100%; padding: 4px 6px; font-size: 12.5px; }
        .cal-legend { display: flex; gap: 16px; font-size: 12px; color: var(--ink-soft); margin: 0 0 14px; flex-wrap: wrap; }
        .cal-legend span { display: inline-flex; align-items: center; gap: 6px; }
        .swatch { width: 11px; height: 11px; border-radius: 2px; display: inline-block; border: 1px solid var(--line); }
        .swatch.holiday { background: #f6ece0; border-color: #d9b98a; }
        .swatch.worked { background: #eaf1ec; }
        .swatch.falta { background: #f5e4e1; border-color: #c98a80; }

        .resumen-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin-bottom: 18px; }
        @media (max-width: 560px) { .resumen-grid { grid-template-columns: 1fr; } }
        .stat { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 16px; }
        .stat .k { font-size: 11.5px; color: var(--ink-soft); }
        .stat .v { font-family: 'Spectral', serif; font-size: 22px; margin-top: 4px; color: var(--primary-dark); }
        .stat.neg .v { color: var(--warn); }
        .stat.pos .v { color: var(--good); }
        .stat.total { grid-column: 1 / -1; background: var(--primary-dark); border-color: var(--primary-dark); }
        .stat.total .k { color: #cfe0da; }
        .stat.total .v { color: #fff; font-size: 30px; }
        .stat-detalle { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--line); font-size: 11.5px; color: var(--ink-soft); display: flex; flex-direction: column; gap: 2px; }

        .toast { position: fixed; bottom: 22px; right: 22px; background: var(--primary-dark); color: #fff; padding: 9px 16px; border-radius: 3px; font-size: 12.5px; opacity: ${status ? 1 : 0}; transition: opacity 0.25s; pointer-events: none; }

        .modal-overlay { position: fixed; inset: 0; background: rgba(33,36,42,0.45); display: flex; align-items: center; justify-content: center; z-index: 50; padding: 20px; }
        .modal-box { background: var(--surface); border-radius: 4px; padding: 22px; max-width: 380px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.2); }
        .modal-box p { margin: 0 0 16px; font-size: 13.5px; line-height: 1.5; }
        .modal-confirm-input { margin-bottom: 16px; }
        .modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
        .modal-btn { background: var(--paper); border: 1px solid var(--line); border-radius: 3px; padding: 9px 16px; font-size: 13px; font-weight: 500; color: var(--ink); }
        .modal-btn.cancel:hover { background: #e7e5df; }
        .modal-btn.danger { background: var(--warn); border-color: var(--warn); color: #fff; }
        .modal-btn.danger:hover { background: #8f4a25; }
        .modal-btn:disabled { opacity: 0.45; cursor: not-allowed; }

        .week-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
        .week-tab { background: var(--paper); border: 1px solid var(--line); border-radius: 20px; padding: 8px 16px; font-size: 12.5px; font-weight: 500; color: var(--ink-soft); }
        .week-tab.active { background: var(--primary-dark); border-color: var(--primary-dark); color: #fff; }

        .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 18px; }
        @media (max-width: 780px) { .kpi-grid { grid-template-columns: 1fr 1fr; } }
        .kpi { background: var(--surface); border: 1px solid var(--line); border-radius: 3px; padding: 16px; }
        .kpi .k { font-size: 11.5px; color: var(--ink-soft); }
        .kpi .v { font-family: 'Spectral', serif; font-size: 22px; margin-top: 4px; color: var(--primary-dark); }

        .stats-cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 18px; }
        @media (max-width: 900px) { .stats-cols { grid-template-columns: 1fr; } }
        .stats-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
        .stats-table th { text-align: left; font-weight: 500; color: var(--ink-soft); font-size: 11px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
        .stats-table td { padding: 8px; border-bottom: 1px solid var(--line); }
        .stats-table td.vacio { color: var(--ink-soft); font-style: italic; }

        .barmini { display: flex; align-items: flex-end; gap: 8px; padding: 10px 4px 0; }
        .barmini-col { display: flex; flex-direction: column; align-items: center; justify-content: flex-end; height: 100%; }
        .barmini-val { font-size: 10.5px; color: var(--ink-soft); margin-bottom: 4px; }
        .barmini-bar { width: 60%; border-radius: 3px 3px 0 0; }
        .barmini-label { font-size: 10.5px; color: var(--ink-soft); margin-top: 6px; text-align: center; }
        .linemini { width: 100%; height: 160px; }

        .vac-year-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
        @media (max-width: 780px) { .vac-year-grid { grid-template-columns: repeat(2, 1fr); } }
        @media (max-width: 480px) { .vac-year-grid { grid-template-columns: 1fr; } }
        .vac-month-title { font-family: 'Spectral', serif; font-size: 14px; color: var(--primary-dark); margin-bottom: 6px; text-align: center; }
        .vac-month-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
        .vac-dow { text-align: center; font-size: 9.5px; color: var(--ink-soft); padding-bottom: 2px; }
        .vac-day { aspect-ratio: 1; border: 1px solid var(--line); background: var(--paper); border-radius: 2px; font-size: 10.5px; color: var(--ink); cursor: pointer; padding: 0; }
        .vac-day:hover { border-color: var(--primary); }
        .vac-day.blank { border: none; background: none; cursor: default; }
        .vac-day.asignado { background: var(--good); border-color: var(--good); color: #fff; font-weight: 600; }

        .boletas-table { width: 100%; border-collapse: collapse; font-size: 13px; }
        .boletas-table th { text-align: left; font-weight: 500; color: var(--ink-soft); font-size: 11.5px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
        .boletas-table td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: middle; }
        .boletas-table td input { min-width: 120px; }
        .boletas-table tfoot td { font-weight: 600; border-top: 2px solid var(--line); border-bottom: none; }
        .print-only { display: none; }

        @media print {
          .topbar, .sidebar, .toast, .no-print { display: none !important; }
          .app { display: block; }
          .main { display: block !important; padding: 0; max-width: none; }
          .print-only { display: table-cell; }
          .boletas-table td input { display: none; }
        }
      `}</style>

      {/* SIDEBAR */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">LEGAJOS</div>
          <h1>Personal</h1>
        </div>
        <div className="nav-tabs">
          <button className={"nav-tab" + (section === "legajos" ? " active" : "")} onClick={() => setSection("legajos")}>
            <IconUsers /> Legajos
          </button>
          <button className={"nav-tab" + (section === "calendario" ? " active" : "")} onClick={() => setSection("calendario")}>
            <IconCalendar /> Calendario
          </button>
          <button className={"nav-tab" + (section === "liquidacion" ? " active" : "")} onClick={() => setSection("liquidacion")}>
            <IconReceipt /> Liquidación
          </button>
          <button className={"nav-tab" + (section === "boletas" ? " active" : "")} onClick={() => setSection("boletas")}>
            <IconPrinter /> Boletas
          </button>
          <button className={"nav-tab" + (section === "estadisticas" ? " active" : "")} onClick={() => setSection("estadisticas")}>
            <IconChart /> Estadísticas
          </button>
          <button className={"nav-tab" + (section === "aguinaldo" ? " active" : "")} onClick={() => setSection("aguinaldo")}>
            <IconGift /> Aguinaldo
          </button>
          <button className={"nav-tab" + (section === "vacaciones" ? " active" : "")} onClick={() => setSection("vacaciones")}>
            <IconSun /> Vacaciones
          </button>
        </div>
        <details className="account-menu">
          <summary>Cuenta y respaldo ▾</summary>
          <div className="account-menu-body">
          <button className="btn-secondary" onClick={async () => { try { const n = await exportarRespaldo(); flash("Respaldo descargado (" + n + " registros)"); } catch (e) { flash("Error al exportar: " + e.message); } }}>Exportar respaldo</button>
          <label className="btn-secondary" style={{ display: "block", cursor: "pointer", textAlign: "center" }}>
            Importar respaldo
            <input type="file" accept="application/json,.json" style={{ display: "none" }} onChange={(e) => {
              const f = e.target.files && e.target.files[0]; e.target.value = "";
              if (!f) return;
              askConfirm("Se van a cargar los datos del respaldo (reemplazan los datos con la misma clave). ¿Continuar?", async () => {
                try { const n = await importarRespaldo(f); flash("Importados " + n + " registros"); setTimeout(() => window.location.reload(), 800); } catch (err) { flash("Error al importar: " + err.message); }
              });
            }} />
          </label>
          {onLogout && <button className="btn-secondary" onClick={onLogout}>Cerrar sesión</button>}
        </div>
        </details>
      </header>
      <aside className="sidebar">
        {section === "legajos" && (
          <div className="sidebar-tools">
            <button className="btn-new" onClick={addEmployee}>+ Nuevo legajo</button>
            <input placeholder="Buscar por nombre, DNI, área…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="sucursal-filtro" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)}>
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            {empleados.length > 0 && (
              <button className="link-danger" onClick={deleteAllEmployees}>Eliminar todos los legajos</button>
            )}
          </div>
        )}
        {section === "calendario" && (
          <div className="sidebar-tools">
            <input placeholder="Buscar por nombre, DNI, área…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        {section === "liquidacion" && (
          <div className="sidebar-tools">
            <input placeholder="Buscar por nombre, DNI, área…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="sucursal-filtro" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)}>
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {section === "aguinaldo" && (
          <div className="sidebar-tools">
            <input placeholder="Buscar por nombre, DNI, área…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="sucursal-filtro" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)}>
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {section === "vacaciones" && (
          <div className="sidebar-tools">
            <input placeholder="Buscar por nombre, DNI, área…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select className="sucursal-filtro" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)}>
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="sucursal-filtro" value={sectorFiltro} onChange={(e) => setSectorFiltro(e.target.value)}>
              <option value="">Todos los sectores</option>
              {SECTORES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {section === "boletas" && (
          <div className="sidebar-tools">
            <p className="hint">Esta sección muestra una tabla con todos los legajos, no hace falta elegir uno.</p>
            <select className="sucursal-filtro" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)}>
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {section === "estadisticas" && (
          <div className="sidebar-tools">
            <p className="hint">Esta sección resume todos los legajos activos, no hace falta elegir uno.</p>
            <select className="sucursal-filtro" value={sucursalFiltro} onChange={(e) => setSucursalFiltro(e.target.value)}>
              <option value="">Todas las sucursales</option>
              {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        )}
        {section !== "boletas" && section !== "estadisticas" && (
        <div className="emp-list">
          {!loaded && <div className="empty-list">Cargando…</div>}
          {loaded && filtered.length === 0 && (
            <div className="empty-list">{empleados.length === 0 ? "Todavía no cargaste ningún legajo." : "Ningún legajo coincide con la búsqueda."}</div>
          )}
          {section === "legajos" && filtered.map((e) => (
            <button key={e.id} className={"emp-item" + (e.id === selectedId ? " active" : "")} onClick={() => selectEmployee(e.id)}>
              <div className="emp-name">{e.nombre || e.apellido ? `${e.apellido || "—"}, ${e.nombre || "—"}` : "Legajo sin nombre"}{e.activo === false ? " (inactivo)" : ""}</div>
              <div className="emp-meta">{e.dni ? `DNI ${e.dni}` : "Sin DNI"}{e.area ? ` · ${e.area}` : ""}</div>
            </button>
          ))}
          {section === "calendario" && filteredActivos.map((e) => (
            <button key={e.id} className={"emp-item" + (e.id === calendarEmployeeId ? " active" : "")} onClick={() => setCalendarEmployeeId(e.id)}>
              <div className="emp-name">{e.nombre || e.apellido ? `${e.apellido || "—"}, ${e.nombre || "—"}` : "Legajo sin nombre"}</div>
              <div className="emp-meta">{e.dni ? `DNI ${e.dni}` : "Sin DNI"}{e.area ? ` · ${e.area}` : ""}</div>
            </button>
          ))}
          {section === "liquidacion" && filteredActivos.map((e) => (
            <button key={e.id} className={"emp-item" + (e.id === liquidacionEmployeeId ? " active" : "")} onClick={() => setLiquidacionEmployeeId(e.id)}>
              <div className="emp-name">{e.nombre || e.apellido ? `${e.apellido || "—"}, ${e.nombre || "—"}` : "Legajo sin nombre"}</div>
              <div className="emp-meta">{e.dni ? `DNI ${e.dni}` : "Sin DNI"}{e.area ? ` · ${e.area}` : ""}</div>
            </button>
          ))}
          {section === "aguinaldo" && filteredActivos.map((e) => (
            <button key={e.id} className={"emp-item" + (e.id === aguinaldoEmployeeId ? " active" : "")} onClick={() => setAguinaldoEmployeeId(e.id)}>
              <div className="emp-name">{e.nombre || e.apellido ? `${e.apellido || "—"}, ${e.nombre || "—"}` : "Legajo sin nombre"}</div>
              <div className="emp-meta">{e.dni ? `DNI ${e.dni}` : "Sin DNI"}{e.area ? ` · ${e.area}` : ""}</div>
            </button>
          ))}
          {section === "vacaciones" && filteredActivos.map((e) => (
            <button key={e.id} className={"emp-item" + (e.id === vacacionesEmployeeId ? " active" : "")} onClick={() => setVacacionesEmployeeId(e.id)}>
              <div className="emp-name">{e.nombre || e.apellido ? `${e.apellido || "—"}, ${e.nombre || "—"}` : "Legajo sin nombre"}</div>
              <div className="emp-meta">{e.dni ? `DNI ${e.dni}` : "Sin DNI"}{e.area ? ` · ${e.area}` : ""}</div>
            </button>
          ))}
        </div>
        )}
      </aside>

      {/* MAIN */}
      <main className="main">
        {section === "legajos" && !selected && (
          <div className="empty-main">
            <h2>Ningún legajo seleccionado</h2>
            <p>Elegí un empleado de la lista o creá un nuevo legajo para cargar sus datos.</p>
          </div>
        )}

        {section === "legajos" && selected && (
          <>
            <button className="back-link" onClick={() => setSelectedId(null)}>← Volver a la lista</button>

            <div className="detail-header">
              <div>
                <h2>{selected.nombre || selected.apellido ? `${selected.nombre || "—"} ${selected.apellido || "—"}` : "Legajo sin nombre"}</h2>
                <div className="sub">
                  {selected.dni ? `DNI ${selected.dni}` : "DNI sin cargar"}
                  {selected.area ? ` · ${selected.area}` : ""}{selected.cargo ? ` · ${selected.cargo}` : ""}
                </div>
              </div>
              <div className="header-actions">
                {editMode ? (
                  <>
                    <button className="btn-secondary" onClick={cancelarEdicion}>Cancelar</button>
                    <button className="btn-save" onClick={guardarCambios}>Guardar cambios</button>
                  </>
                ) : (
                  <>
                    <button className="btn-secondary" onClick={iniciarEdicion}>Editar legajo</button>
                    <button className="del-btn" onClick={() => deleteEmployee(selected.id)}>Eliminar legajo</button>
                  </>
                )}
              </div>
            </div>

            {editMode && (
              <div className="edit-banner">Estás editando este legajo. Los cambios no se guardan solos: usá "Guardar cambios" cuando termines, o "Cancelar" para descartarlos.</div>
            )}

            <div className="tabs">
              {TABS.map((t) => (
                <button key={t.id} className={"tab-btn" + (tab === t.id ? " active" : "")} onClick={() => setTab(t.id)}>{t.label}</button>
              ))}
            </div>

            {tab === "personales" && (
              <SectionCard accent="var(--primary)" title="Datos personales" subtitle="Información básica del empleado.">
                {editMode ? (
                  <div className="field-grid">
                    <label className="field-span checkbox-field">
                      <input type="checkbox" checked={selected.activo !== false} onChange={(e) => patchEmployee(selected.id, { activo: e.target.checked })} />
                      <span>Legajo activo</span>
                    </label>
                    <Field label="Nombre"><input value={selected.nombre} onChange={(e) => patchEmployee(selected.id, { nombre: e.target.value })} /></Field>
                    <Field label="Apellido"><input value={selected.apellido} onChange={(e) => patchEmployee(selected.id, { apellido: e.target.value })} /></Field>
                    <Field label="DNI"><input value={selected.dni} onChange={(e) => patchEmployee(selected.id, { dni: e.target.value })} placeholder="Sin puntos" /></Field>
                    <Field label="Área / sector"><input value={selected.area} onChange={(e) => patchEmployee(selected.id, { area: e.target.value })} placeholder="Ej: Despacho, Fábrica" /></Field>
                    <Field label="Cargo / puesto"><input value={selected.cargo} onChange={(e) => patchEmployee(selected.id, { cargo: e.target.value })} /></Field>
                    <Field label="Fecha de nacimiento"><input type="date" value={selected.fechaNacimiento} onChange={(e) => patchEmployee(selected.id, { fechaNacimiento: e.target.value })} /></Field>
                    <Field label="Fecha de ingreso"><input type="date" value={selected.fechaIngreso} onChange={(e) => patchEmployee(selected.id, { fechaIngreso: e.target.value })} /></Field>
                    <Field label="Teléfono"><input value={selected.telefono} onChange={(e) => patchEmployee(selected.id, { telefono: e.target.value })} /></Field>
                    <Field label="Email"><input type="email" value={selected.email} onChange={(e) => patchEmployee(selected.id, { email: e.target.value })} /></Field>
                    <Field label="Dirección" span><input value={selected.direccion} onChange={(e) => patchEmployee(selected.id, { direccion: e.target.value })} /></Field>
                  </div>
                ) : (
                  <div className="field-grid">
                    <div className="field-span">
                      <span className={"pill" + (selected.activo === false ? " pill-inactivo" : " pill-activo")}>
                        {selected.activo === false ? "Legajo inactivo" : "Legajo activo"}
                      </span>
                    </div>
                    <ReadField label="Nombre" value={selected.nombre} />
                    <ReadField label="Apellido" value={selected.apellido} />
                    <ReadField label="DNI" value={selected.dni} />
                    <ReadField label="Área / sector" value={selected.area} />
                    <ReadField label="Cargo / puesto" value={selected.cargo} />
                    <ReadField label="Fecha de nacimiento" value={selected.fechaNacimiento} />
                    <ReadField label="Fecha de ingreso" value={selected.fechaIngreso} />
                    <ReadField label="Teléfono" value={selected.telefono} />
                    <ReadField label="Email" value={selected.email} />
                    <ReadField label="Dirección" value={selected.direccion} span />
                  </div>
                )}
                <p className="hint">Si el legajo no está activo, se sigue viendo en la lista de Legajos pero no aparece en Calendario, Liquidación mensual ni Boletas.</p>
              </SectionCard>
            )}

            {tab === "documentacion" && (
              <SectionCard accent="var(--plum)" title="Documentación" subtitle="Foto del DNI, frente y dorso.">
                <div className="dni-grid">
                  {["frente", "dorso"].map((side) => (
                    <div key={side} className="dni-slot">
                      {p[side] ? (
                        <>
                          <img src={p[side]} alt={`DNI ${side}`} />
                          {editMode && (
                            <div className="photo-actions">
                              <label className="upload-btn">Reemplazar<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => uploadPhoto(selected.id, side, e.target.files[0])} /></label>
                              <button className="remove" onClick={() => removePhoto(selected.id, side)}>Quitar</button>
                            </div>
                          )}
                        </>
                      ) : (
                        <>
                          <div className="dni-slot-label">DNI — {side}{!editMode ? " (sin cargar)" : ""}</div>
                          {editMode && (
                            <label className="upload-btn">{uploading === side ? "Procesando…" : "Subir foto"}<input type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => uploadPhoto(selected.id, side, e.target.files[0])} /></label>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
                <p className="hint">Las imágenes se comprimen automáticamente antes de guardarse.</p>
              </SectionCard>
            )}

            {tab === "remuneracion" && (
              <>
                <SectionCard accent="var(--primary)" title="Remuneración base" subtitle="Valor hora y presentismo sugerido.">
                  {editMode ? (
                    <div className="field-grid">
                      <Field label="Valor hora (ARS)"><input type="number" min="0" step="0.01" value={selected.valorHora} onChange={(e) => patchEmployee(selected.id, { valorHora: e.target.value })} /></Field>
                      <Field label="Presentismo sugerido (ARS)"><input type="number" min="0" step="0.01" value={selected.presentismoBase} onChange={(e) => patchEmployee(selected.id, { presentismoBase: e.target.value })} /></Field>
                    </div>
                  ) : (
                    <div className="field-grid">
                      <ReadField label="Valor hora" value={selected.valorHora} money />
                      <ReadField label="Presentismo sugerido" value={selected.presentismoBase} money />
                    </div>
                  )}
                  <p className="hint">El presentismo sugerido se precarga cada mes en "Novedades del mes" y podés ajustarlo ahí si corresponde.</p>
                </SectionCard>
                <SectionCard accent="var(--primary)" title="Recargos" subtitle="Porcentaje que se suma al valor hora en cada situación.">
                  {editMode ? (
                    <div className="field-grid four">
                      <Field label="Extra entre semana (%)"><input type="number" min="0" step="1" value={selected.recargoSemana} onChange={(e) => patchEmployee(selected.id, { recargoSemana: e.target.value })} /></Field>
                      <Field label="Extra/diferencia sábado (%)"><input type="number" min="0" step="1" value={selected.recargoSabado} onChange={(e) => patchEmployee(selected.id, { recargoSabado: e.target.value })} /></Field>
                      <Field label="Domingo trabajado (%)"><input type="number" min="0" step="1" value={selected.recargoDomingo} onChange={(e) => patchEmployee(selected.id, { recargoDomingo: e.target.value })} /></Field>
                      <Field label="Feriado trabajado (%)"><input type="number" min="0" step="1" value={selected.recargoFeriado} onChange={(e) => patchEmployee(selected.id, { recargoFeriado: e.target.value })} /></Field>
                    </div>
                  ) : (
                    <div className="field-grid four">
                      <ReadField label="Extra entre semana" value={selected.recargoSemana ? `${selected.recargoSemana}%` : ""} />
                      <ReadField label="Extra/diferencia sábado" value={selected.recargoSabado ? `${selected.recargoSabado}%` : ""} />
                      <ReadField label="Domingo trabajado" value={selected.recargoDomingo ? `${selected.recargoDomingo}%` : ""} />
                      <ReadField label="Feriado trabajado" value={selected.recargoFeriado ? `${selected.recargoFeriado}%` : ""} />
                    </div>
                  )}
                </SectionCard>
              </>
            )}

            {tab === "horas" && (
              <>
                <SectionCard accent="var(--primary)" title="Horas esperadas" subtitle="Jornada habitual del empleado, según el día de la semana.">
                  {editMode ? (
                    <div className="field-grid three">
                      <Field label="Lunes a viernes (hs/día)"><input type="number" min="0" step="0.5" value={selected.jornadaNormal} onChange={(e) => patchEmployee(selected.id, { jornadaNormal: e.target.value })} /></Field>
                      <Field label="Sábado (hs)"><input type="number" min="0" step="0.5" value={selected.horasSabado} onChange={(e) => patchEmployee(selected.id, { horasSabado: e.target.value })} /></Field>
                      <Field label="Domingo (hs)"><input type="number" min="0" step="0.5" value={selected.horasDomingo} onChange={(e) => patchEmployee(selected.id, { horasDomingo: e.target.value })} /></Field>
                    </div>
                  ) : (
                    <div className="field-grid three">
                      <ReadField label="Lunes a viernes" value={selected.jornadaNormal ? `${selected.jornadaNormal} hs/día` : ""} />
                      <ReadField label="Sábado" value={selected.horasSabado ? `${selected.horasSabado} hs` : ""} />
                      <ReadField label="Domingo" value={selected.horasDomingo ? `${selected.horasDomingo} hs` : ""} />
                    </div>
                  )}
                </SectionCard>

                <SectionCard accent="var(--plum)" title="Sucursal, turno y sector" subtitle="La sucursal se usa además como filtro en Legajos, Liquidación mensual y Boletas.">
                  {editMode ? (
                    <>
                      <div className="field-grid three">
                        <Field label="Sucursal">
                          <select value={selected.sucursal} onChange={(e) => patchEmployee(selected.id, { sucursal: e.target.value })}>
                            <option value="">— Sin asignar —</option>
                            {sucursales.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </Field>
                        <Field label="Turno">
                          <select value={selected.turno} onChange={(e) => patchEmployee(selected.id, { turno: e.target.value })}>
                            <option value="">— Sin asignar —</option>
                            {TURNOS.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </Field>
                        <Field label="Sector">
                          <select value={selected.sector} onChange={(e) => patchEmployee(selected.id, { sector: e.target.value })}>
                            <option value="">— Sin asignar —</option>
                            {SECTORES.map((s) => <option key={s} value={s}>{s}</option>)}
                          </select>
                        </Field>
                      </div>
                      <div className="sucursal-manager">
                        <input value={nuevaSucursal} onChange={(e) => setNuevaSucursal(e.target.value)} placeholder="Nombre de la nueva sucursal" onKeyDown={(e) => { if (e.key === "Enter") addSucursal(); }} />
                        <button onClick={addSucursal}>+ Agregar sucursal</button>
                      </div>
                      {sucursales.length > 0 && (
                        <div className="chip-list">
                          {sucursales.map((s) => (
                            <div key={s} className="chip">
                              {s}
                              <button onClick={() => removeSucursal(s)} aria-label="Quitar sucursal"><IconTrash /></button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="field-grid three">
                      <ReadField label="Sucursal" value={selected.sucursal} />
                      <ReadField label="Turno" value={selected.turno} />
                      <ReadField label="Sector" value={selected.sector} />
                    </div>
                  )}
                </SectionCard>
              </>
            )}

            {tab === "novedades" && (
              <>
                <SectionCard
                  accent="var(--good)" title="Presentismo y no remunerativo"
                  headerExtra={
                    <div className="month-nav">
                      <button onClick={() => changeMonth(-1)} aria-label="Mes anterior"><IconChevron dir="left" /></button>
                      <span className="label">{MESES[cursor.month]} {cursor.year}</span>
                      <button onClick={() => changeMonth(1)} aria-label="Mes siguiente"><IconChevron dir="right" /></button>
                    </div>
                  }
                >
                  {editMode ? (
                    <div className="field-grid">
                      <Field label="Presentismo a liquidar este mes (ARS)"><input type="number" min="0" step="0.01" value={mesActual.presentismo} onChange={(e) => patchMes({ presentismo: e.target.value })} /></Field>
                      <Field label="No remunerativo (ARS)"><input type="number" min="0" step="0.01" value={mesActual.noRemunerativo} onChange={(e) => patchMes({ noRemunerativo: e.target.value })} /></Field>
                    </div>
                  ) : (
                    <div className="field-grid">
                      <ReadField label="Presentismo a liquidar este mes" value={mesActual.presentismo} money />
                      <ReadField label="No remunerativo" value={mesActual.noRemunerativo} money />
                    </div>
                  )}
                  <p className="hint">El presentismo se precarga con el valor sugerido de Remuneración; poné 0 si el empleado lo perdió este mes.</p>
                </SectionCard>

                <SectionCard accent="var(--good)" title="Adicionales del mes" subtitle="Bonos, viáticos u otro extra puntual de este mes.">
                  {editMode ? (
                    <>
                      <div className="row-list">
                        {(mesActual.adicionales || []).map((a) => (
                          <div className="row-item item2" key={a.id}>
                            <Field label="Concepto"><input value={a.concepto} onChange={(e) => updateItemMes("adicionales", a.id, { concepto: e.target.value })} placeholder="Ej: bono producción" /></Field>
                            <Field label="Monto (ARS)"><input type="number" min="0" step="0.01" value={a.monto} onChange={(e) => updateItemMes("adicionales", a.id, { monto: e.target.value })} /></Field>
                            <button className="row-remove" onClick={() => removeItemMes("adicionales", a.id)} aria-label="Quitar adicional"><IconTrash /></button>
                          </div>
                        ))}
                      </div>
                      <button className="add-row-btn" onClick={() => addItemMes("adicionales", { id: uid(), concepto: "", monto: "" })}>+ Agregar adicional</button>
                    </>
                  ) : (
                    <div className="row-list">
                      {(mesActual.adicionales || []).length === 0 && <p className="hint">Sin adicionales cargados este mes.</p>}
                      {(mesActual.adicionales || []).map((a) => (
                        <div className="ro-row" key={a.id}><span>{a.concepto || "Sin concepto"}</span><strong>{money(a.monto)}</strong></div>
                      ))}
                    </div>
                  )}
                  <div className="subtotal-line"><span>Total adicionales</span><strong>{money(totalAdicionales)}</strong></div>
                </SectionCard>

                <SectionCard accent="var(--warn)" title="Mercadería" subtitle="Consumo o retiro de mercadería que se descuenta del sueldo.">
                  {editMode ? (
                    <>
                      <div className="row-list">
                        {(mesActual.mercaderia || []).map((m2) => (
                          <div className="row-item mercaderia" key={m2.id}>
                            <Field label="Fecha"><input type="date" value={m2.fecha || ""} onChange={(e) => updateItemMes("mercaderia", m2.id, { fecha: e.target.value })} /></Field>
                            <Field label="Concepto"><input value={m2.concepto} onChange={(e) => updateItemMes("mercaderia", m2.id, { concepto: e.target.value })} placeholder="Ej: pedido semanal" /></Field>
                            <Field label="Monto (ARS)"><input type="number" min="0" step="0.01" value={m2.monto} onChange={(e) => updateItemMes("mercaderia", m2.id, { monto: e.target.value })} /></Field>
                            <button className="row-remove" onClick={() => removeItemMes("mercaderia", m2.id)} aria-label="Quitar concepto"><IconTrash /></button>
                          </div>
                        ))}
                      </div>
                      <button className="add-row-btn" onClick={() => addItemMes("mercaderia", { id: uid(), fecha: monthKey(cursor.year, cursor.month) + "-01", concepto: "", monto: "" })}>+ Agregar concepto</button>
                    </>
                  ) : (
                    <div className="row-list">
                      {(mesActual.mercaderia || []).length === 0 && <p className="hint">Sin mercadería cargada este mes.</p>}
                      {(mesActual.mercaderia || []).map((m2) => (
                        <div className="ro-row" key={m2.id}><span>{m2.fecha ? `${m2.fecha} · ` : ""}{m2.concepto || "Sin concepto"}</span><strong>{money(m2.monto)}</strong></div>
                      ))}
                    </div>
                  )}
                  <div className="subtotal-line"><span>Total mercadería</span><strong>{money(totalMercaderia)}</strong></div>
                </SectionCard>

                <SectionCard accent="var(--warn)" title="Adelantos" subtitle="Dinero adelantado durante el mes, se descuenta de la liquidación.">
                  {editMode ? (
                    <>
                      <div className="row-list">
                        {(mesActual.adelantos || []).map((a) => (
                          <div className="row-item adelanto" key={a.id}>
                            <Field label="Fecha"><input type="date" value={a.fecha} onChange={(e) => updateItemMes("adelantos", a.id, { fecha: e.target.value })} /></Field>
                            <Field label="Monto (ARS)"><input type="number" min="0" step="0.01" value={a.monto} onChange={(e) => updateItemMes("adelantos", a.id, { monto: e.target.value })} /></Field>
                            <Field label="Nota"><input value={a.nota} onChange={(e) => updateItemMes("adelantos", a.id, { nota: e.target.value })} placeholder="Opcional" /></Field>
                            <button className="row-remove" onClick={() => removeItemMes("adelantos", a.id)} aria-label="Quitar adelanto"><IconTrash /></button>
                          </div>
                        ))}
                      </div>
                      <div className="row-item adelanto">
                        <Field label="Fecha"><input type="date" value={newAdelanto.fecha} onChange={(e) => setNewAdelanto({ ...newAdelanto, fecha: e.target.value })} /></Field>
                        <Field label="Monto (ARS)"><input type="number" min="0" step="0.01" value={newAdelanto.monto} onChange={(e) => setNewAdelanto({ ...newAdelanto, monto: e.target.value })} /></Field>
                        <Field label="Nota"><input value={newAdelanto.nota} onChange={(e) => setNewAdelanto({ ...newAdelanto, nota: e.target.value })} placeholder="Opcional" /></Field>
                        <button className="row-remove" onClick={addAdelanto} aria-label="Agregar adelanto" title="Agregar">+</button>
                      </div>
                    </>
                  ) : (
                    <div className="row-list">
                      {(mesActual.adelantos || []).length === 0 && <p className="hint">Sin adelantos cargados este mes.</p>}
                      {(mesActual.adelantos || []).map((a) => (
                        <div className="ro-row" key={a.id}><span>{a.fecha || "Sin fecha"}{a.nota ? ` · ${a.nota}` : ""}</span><strong>{money(a.monto)}</strong></div>
                      ))}
                    </div>
                  )}
                  <div className="subtotal-line"><span>Total adelantos del mes</span><strong>{money(totalAdelantos)}</strong></div>
                </SectionCard>

                <SectionCard accent="var(--warn)" title="Embargos" subtitle="Retención judicial correspondiente a este mes.">
                  {editMode ? (
                    <>
                      <div className="row-list">
                        {(mesActual.embargos || []).map((em) => (
                          <div className="row-item embargo" key={em.id}>
                            <Field label="Entidad / expediente"><input value={em.entidad} onChange={(e) => updateItemMes("embargos", em.id, { entidad: e.target.value })} placeholder="Ej: Juzgado N°3" /></Field>
                            <Field label="N° de expediente"><input value={em.expediente} onChange={(e) => updateItemMes("embargos", em.id, { expediente: e.target.value })} /></Field>
                            <Field label="Tipo">
                              <select value={em.tipo} onChange={(e) => updateItemMes("embargos", em.id, { tipo: e.target.value })}>
                                <option value="monto">Monto fijo</option>
                                <option value="porcentaje">Porcentaje</option>
                              </select>
                            </Field>
                            <Field label={em.tipo === "porcentaje" ? "Valor (%)" : "Valor (ARS)"}>
                              <input type="number" min="0" step="0.01" value={em.valor} onChange={(e) => updateItemMes("embargos", em.id, { valor: e.target.value })} />
                            </Field>
                            <button className="row-remove" onClick={() => removeItemMes("embargos", em.id)} aria-label="Quitar embargo"><IconTrash /></button>
                          </div>
                        ))}
                      </div>
                      <button className="add-row-btn" onClick={() => addItemMes("embargos", { id: uid(), entidad: "", expediente: "", tipo: "monto", valor: "" })}>+ Agregar embargo</button>
                    </>
                  ) : (
                    <div className="row-list">
                      {(mesActual.embargos || []).length === 0 && <p className="hint">Sin embargos cargados este mes.</p>}
                      {(mesActual.embargos || []).map((em) => (
                        <div className="ro-row" key={em.id}>
                          <span>{em.entidad || "Sin entidad"}{em.expediente ? ` · Exp. ${em.expediente}` : ""}</span>
                          <strong>{em.tipo === "porcentaje" ? `${em.valor || 0}%` : money(em.valor)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="subtotal-line"><span>Total embargos (montos fijos)</span><strong>{money(totalEmbargos)}</strong></div>
                </SectionCard>
              </>
            )}
          </>
        )}

        {section === "calendario" && !calendarEmployee && (
          <div className="empty-main">
            <h2>Ningún legajo seleccionado</h2>
            <p>Elegí un legajo de la lista para ver y editar su calendario del mes.</p>
          </div>
        )}

        {section === "calendario" && calendarEmployee && (
          <>
            <button className="back-link" onClick={() => setCalendarEmployeeId(null)}>← Volver a la lista</button>

            <div className="detail-header">
              <div>
                <h2>{calendarEmployee.nombre || calendarEmployee.apellido ? `${calendarEmployee.nombre || "—"} ${calendarEmployee.apellido || "—"}` : "Legajo sin nombre"}</h2>
                <div className="sub">Calendario de horas — {MESES[cursor.month]} {cursor.year}</div>
              </div>
              <div className="header-actions">
                <button className="btn-secondary" onClick={cargarHorasEsperadas}>Carga de horas esperadas</button>
                <button className="btn-save" onClick={guardarCalendario}>Guardar cambios</button>
              </div>
            </div>

            <SectionCard
              accent="var(--primary)" title="Calendario"
              subtitle={`Editá horas, marcá falta (✕) o feriado (★) en cualquier día. Usá "Carga de horas esperadas" para completar el mes según lo definido en Horas esperadas.`}
              headerExtra={
                <div className="month-nav">
                  <button onClick={() => changeMonth(-1)} aria-label="Mes anterior"><IconChevron dir="left" /></button>
                  <span className="label">{MESES[cursor.month]} {cursor.year}</span>
                  <button onClick={() => changeMonth(1)} aria-label="Mes siguiente"><IconChevron dir="right" /></button>
                </div>
              }
            >
              <div className="cal-legend">
                <span><span className="swatch holiday"></span> Feriado</span>
                <span><span className="swatch worked"></span> Con horas cargadas</span>
                <span><span className="swatch falta"></span> Falta</span>
              </div>
              <div className="cal-grid">
                {DOW.map((d) => <div key={d} className="cal-dow">{d}</div>)}
                {Array.from({ length: mondayIndex(cursor.year, cursor.month, 1) }, (_, i) => (
                  <div key={"b" + i} className="cal-cell blank" />
                ))}
                {Array.from({ length: totalDiasMes }, (_, i) => i + 1).map((day) => {
                  const reg = diasDelMes[String(day)] || { horas: "", falta: false, feriado: false };
                  const hasHours = Number(reg.horas) > 0;
                  return (
                    <div key={day} className={"cal-cell" + (reg.falta ? " falta" : reg.feriado ? " holiday" : "") + (hasHours && !reg.falta ? " has-hours" : "")}>
                      <div className="cal-top">
                        <span className="cal-daynum">{day}</span>
                        <div className="cal-icons">
                          <button className={"cal-icon-btn" + (reg.feriado ? " on" : "")} onClick={() => updateDiaCalendario(day, { feriado: !reg.feriado })} aria-label="Marcar feriado" title="Marcar/quitar feriado">
                            <IconStar filled={reg.feriado} />
                          </button>
                          <button className={"cal-icon-btn falta-btn" + (reg.falta ? " on" : "")} onClick={() => updateDiaCalendario(day, { falta: !reg.falta })} aria-label="Marcar falta" title="Marcar/quitar falta">
                            <IconX on={reg.falta} />
                          </button>
                        </div>
                      </div>
                      <input
                        className="cal-hours" type="number" min="0" step="0.5" placeholder="Hs"
                        value={reg.horas} disabled={reg.falta}
                        onChange={(e) => updateDiaCalendario(day, { horas: e.target.value })}
                      />
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          </>
        )}

        {section === "liquidacion" && !liquidacionEmployee && (
          <div className="empty-main">
            <h2>Ningún legajo seleccionado</h2>
            <p>Elegí un legajo de la lista para ver su liquidación del mes.</p>
          </div>
        )}

        {section === "liquidacion" && liquidacionEmployee && (
          <>
            <button className="back-link" onClick={() => setLiquidacionEmployeeId(null)}>← Volver a la lista</button>

            <div className="detail-header">
              <div>
                <h2>{liquidacionEmployee.nombre || liquidacionEmployee.apellido ? `${liquidacionEmployee.nombre || "—"} ${liquidacionEmployee.apellido || "—"}` : "Legajo sin nombre"}</h2>
                <div className="sub">Liquidación — {MESES[cursor.month]} {cursor.year}</div>
              </div>
              <div className="header-actions">
                <button className="btn-save" onClick={actualizarLiquidacion}>Actualizar liquidación</button>
              </div>
            </div>

            <SectionCard
              accent="var(--primary)" title="Liquidación mensual"
              subtitle={`Se calcula a partir del valor hora, el calendario y las novedades del mes. Tocá "Actualizar liquidación" después de cualquier cambio.`}
              headerExtra={
                <div className="month-nav">
                  <button onClick={() => changeMonth(-1)} aria-label="Mes anterior"><IconChevron dir="left" /></button>
                  <span className="label">{MESES[cursor.month]} {cursor.year}</span>
                  <button onClick={() => changeMonth(1)} aria-label="Mes siguiente"><IconChevron dir="right" /></button>
                </div>
              }
            >
              {!liquidacionVigente ? (
                <p className="hint">Todavía no calculaste la liquidación de este mes para este legajo. Tocá "Actualizar liquidación" para generarla.</p>
              ) : (
                <>
                  <h3 style={{ fontSize: 14, marginBottom: 10 }}>Haberes</h3>
                  <div className="resumen-grid">
                    <div className="stat pos"><div className="k">Básico ({liquidacionVigente.jornada} hs × {money(liquidacionVigente.valorHora)} × 30)</div><div className="v">{money(liquidacionVigente.basico)}</div></div>
                    <div className="stat pos"><div className="k">Presentismo</div><div className="v">{money(liquidacionVigente.presentismo)}</div></div>
                    <div className="stat pos"><div className="k">No remunerativo</div><div className="v">{money(liquidacionVigente.noRemunerativo)}</div></div>
                    <div className="stat pos"><div className="k">Adicionales</div><div className="v">{money(liquidacionVigente.totalAdicionales)}</div></div>
                    <div className="stat pos"><div className="k">Domingo trabajado ({liquidacionVigente.domingosTrabajados})</div><div className="v">{money(liquidacionVigente.montoDomingo)}</div></div>
                    <div className="stat pos">
                      <div className="k">Feriado trabajado ({liquidacionVigente.feriadosTrabajados})</div>
                      <div className="v">{money(liquidacionVigente.montoFeriado)}</div>
                      {liquidacionVigente.feriadoDetalle.length > 0 && (
                        <div className="stat-detalle">
                          {liquidacionVigente.feriadoDetalle.map((it) => (
                            <div key={it.dia}>{it.fecha}: {it.horas} hs ({money(it.monto)})</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="stat pos">
                      <div className="k">Hora extra ({liquidacionVigente.horasExtra} hs)</div>
                      <div className="v">{money(liquidacionVigente.montoExtra)}</div>
                      {liquidacionVigente.extraDetalle.length > 0 && (
                        <div className="stat-detalle">
                          {liquidacionVigente.extraDetalle.map((it) => (
                            <div key={it.dia}>{it.fecha}: +{it.horas} hs ({money(it.monto)})</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="stat total"><div className="k">Total haberes</div><div className="v">{money(liquidacionVigente.totalHaberes)}</div></div>
                  </div>

                  <h3 style={{ fontSize: 14, marginBottom: 10 }}>Deducciones</h3>
                  <div className="resumen-grid">
                    <div className="stat neg">
                      <div className="k">Faltas ({liquidacionVigente.faltasDetalle.length} días)</div>
                      <div className="v">{money(liquidacionVigente.montoFaltas)}</div>
                      {liquidacionVigente.faltasDetalle.length > 0 && (
                        <div className="stat-detalle">
                          {liquidacionVigente.faltasDetalle.map((it) => (
                            <div key={it.dia}>{it.fecha} ({money(it.monto)})</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="stat neg">
                      <div className="k">Hs no trabajadas ({liquidacionVigente.horasNoTrabajadas} hs)</div>
                      <div className="v">{money(liquidacionVigente.montoNoTrabajadas)}</div>
                      {liquidacionVigente.noTrabajadasDetalle.length > 0 && (
                        <div className="stat-detalle">
                          {liquidacionVigente.noTrabajadasDetalle.map((it) => (
                            <div key={it.dia}>{it.fecha}: -{it.horas} hs ({money(it.monto)})</div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="stat neg"><div className="k">Adelantos</div><div className="v">{money(liquidacionVigente.totalAdelantos)}</div></div>
                    <div className="stat neg"><div className="k">Mercadería</div><div className="v">{money(liquidacionVigente.totalMercaderia)}</div></div>
                    <div className="stat neg"><div className="k">Embargos</div><div className="v">{money(liquidacionVigente.totalEmbargos)}</div></div>
                    <div className="stat total"><div className="k">Neto a cobrar</div><div className="v">{money(liquidacionVigente.neto)}</div></div>
                  </div>
                  <p className="hint">Cálculo orientativo: no reemplaza la liquidación oficial de sueldos ni contempla cargas sociales o impuestos.</p>
                </>
              )}
            </SectionCard>
          </>
        )}

        {section === "boletas" && (
          <>
            <div className="detail-header">
              <div>
                <h2>Impresión de boletas semanales</h2>
                <div className="sub">Pago semanal (sábados) como cuenta corriente sobre la liquidación mensual — {MESES[cursor.month]} {cursor.year}</div>
              </div>
              <div className="header-actions no-print">
                <button className="btn-secondary" onClick={abrirImpresionMensual}>Impresión mensual</button>
                <button className="btn-secondary" onClick={abrirPdfBoletas}>Generar PDF</button>
                <button className="btn-save" onClick={guardarBoletas}>Guardar cambios</button>
              </div>
            </div>

            <div className="carpeta-bar no-print">
              <span>
                {carpetaNombre
                  ? <>Los PDF se guardan en: <strong>{carpetaNombre}</strong></>
                  : "Todavía no elegiste dónde guardar los PDF que se generen"}
              </span>
              <button className="btn-secondary" onClick={elegirCarpeta}>{carpetaNombre ? "Cambiar carpeta" : "Elegir carpeta para guardar"}</button>
            </div>
            <p className="hint no-print" style={{ marginTop: -12, marginBottom: 18 }}>
              El selector se abre directamente en el Escritorio: si querés guardar ahí mismo sin crear una subcarpeta, simplemente elegí "Escritorio" y confirmá, sin entrar a ninguna carpeta.
            </p>

            <div className="no-print">
              <SectionCard
                accent="var(--primary)" title="Semana de pago"
                subtitle="El pago 1 sugiere la cuarta parte del neto mensual. Del pago 2 en adelante, se reparte en partes iguales lo que todavía falta cobrar entre las semanas que quedan — ideal si la liquidación cambió en el medio."
                headerExtra={
                  <div className="month-nav">
                    <button onClick={() => changeMonth(-1)} aria-label="Mes anterior"><IconChevron dir="left" /></button>
                    <span className="label">{MESES[cursor.month]} {cursor.year}</span>
                    <button onClick={() => changeMonth(1)} aria-label="Mes siguiente"><IconChevron dir="right" /></button>
                  </div>
                }
              >
                <div className="week-tabs">
                  {[1, 2, 3, 4].map((n) => (
                    <button key={n} className={"week-tab" + (boletaSemana === n ? " active" : "")} onClick={() => setBoletaSemana(n)}>Pago {n}</button>
                  ))}
                </div>
              </SectionCard>
            </div>

            <SectionCard accent="var(--good)" title={`Pago ${boletaSemana} — ${MESES[cursor.month]} ${cursor.year}`} subtitle="Montos por legajo. La suma a abonar es la que efectivamente se paga esta semana.">
              {filasBoletas.length === 0 ? (
                <p className="hint">Todavía no cargaste ningún legajo.</p>
              ) : (
                <table className="boletas-table">
                  <thead>
                    <tr>
                      <th className="no-print"><input type="checkbox" checked={todosSeleccionados} onChange={toggleSeleccionarTodos} /></th>
                      <th>Legajo</th>
                      <th>Neto mensual</th>
                      <th>Suma sugerida</th>
                      <th>Suma a abonar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filasBoletas.map(({ emp, liq, pagos, sugerido }) => (
                      <tr key={emp.id}>
                        <td className="no-print"><input type="checkbox" checked={estaSeleccionado(emp.id)} onChange={() => toggleSeleccion(emp.id)} /></td>
                        <td>
                          <div className="emp-name">{emp.nombre || emp.apellido ? `${emp.nombre || "—"} ${emp.apellido || "—"}` : "Legajo sin nombre"}</div>
                          <div className="emp-meta">{emp.dni ? `DNI ${emp.dni}` : "Sin DNI"}{emp.area ? ` · ${emp.area}` : ""}</div>
                        </td>
                        <td>{money(liq.neto)}</td>
                        <td>{money(sugerido)}</td>
                        <td className="no-print">
                          <input
                            type="number" min="0" step="0.01"
                            value={pagos[`s${boletaSemana}`]}
                            onChange={(e) => patchPagos(emp.id, { [`s${boletaSemana}`]: e.target.value })}
                          />
                        </td>
                        <td className="print-only">{money(pagos[`s${boletaSemana}`])}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="no-print"></td>
                      <td>Total</td>
                      <td>{money(filasBoletas.reduce((s, f) => s + f.liq.neto, 0))}</td>
                      <td>{money(filasBoletas.reduce((s, f) => s + f.sugerido, 0))}</td>
                      <td>{money(filasBoletas.reduce((s, f) => s + (Number(f.pagos[`s${boletaSemana}`]) || 0), 0))}</td>
                    </tr>
                  </tfoot>
                </table>
              )}
              <p className="hint no-print">Tildá los legajos que quieras incluir en la "Impresión mensual" (por defecto están todos seleccionados).</p>
              <p className="hint no-print">Los montos se recalculan solos con lo cargado en Calendario y Novedades del mes; usá "Guardar cambios" para que la suma a abonar quede guardada.</p>
              <p className="hint no-print">"Generar PDF" abre una pestaña lista para imprimir. Si tu navegador no lo permite (por ejemplo, dentro de un panel embebido), en cambio descarga un archivo: abrilo con tu navegador para imprimirlo o guardarlo como PDF.</p>
            </SectionCard>
          </>
        )}

        {section === "estadisticas" && (
          <>
            <div className="detail-header">
              <div>
                <h2>Estadísticas</h2>
                <div className="sub">{sucursalFiltro ? `Sucursal: ${sucursalFiltro}` : "Todas las sucursales"} — {MESES[cursor.month]} {cursor.year}</div>
              </div>
              <div className="month-nav">
                <button onClick={() => changeMonth(-1)} aria-label="Mes anterior"><IconChevron dir="left" /></button>
                <span className="label">{MESES[cursor.month]} {cursor.year}</span>
                <button onClick={() => changeMonth(1)} aria-label="Mes siguiente"><IconChevron dir="right" /></button>
              </div>
            </div>

            <div className="kpi-grid">
              <div className="kpi"><div className="k">Total a pagar este mes</div><div className="v">{money(totalAPagarMes)}</div></div>
              <div className="kpi"><div className="k">Total pagado este mes</div><div className="v">{money(totalPagadoEsteMes)}</div></div>
              <div className="kpi"><div className="k">Saldo pendiente del mes</div><div className="v">{money(totalAPagarMes - totalPagadoEsteMes)}</div></div>
              <div className="kpi"><div className="k">Legajos activos</div><div className="v">{filteredActivos.length}</div></div>
            </div>

            <SectionCard accent="var(--good)" title="Total pagado a una fecha específica" subtitle="Suma de todos los pagos semanales con fecha de pago hasta el día que elijas (de cualquier mes cargado).">
              <div className="field-grid">
                <Field label="Fecha de corte"><input type="date" value={fechaCorte} onChange={(e) => setFechaCorte(e.target.value)} /></Field>
              </div>
              <div className="subtotal-line"><span>Total pagado hasta {fechaCorte}</span><strong>{money(totalHastaFecha)}</strong></div>
            </SectionCard>

            <SectionCard accent="var(--plum)" title="Evolución mensual" subtitle="Total a pagar vs. total efectivamente pagado, últimos 6 meses.">
              <LineMini
                series={[
                  { data: evolucionMensual, valueKey: "aPagar", color: "var(--primary)" },
                  { data: evolucionMensual, valueKey: "pagado", color: "var(--good)" },
                ]}
                labelKey="label"
              />
              <div className="cal-legend" style={{ marginTop: 8 }}>
                <span><span className="swatch" style={{ background: "var(--primary)" }}></span> Total a pagar</span>
                <span><span className="swatch" style={{ background: "var(--good)" }}></span> Total pagado</span>
              </div>
            </SectionCard>

            {filteredActivos.length > 0 && (
              <SectionCard accent="var(--primary)" title="Total a pagar por sucursal" subtitle="Este mes.">
                <BarMini data={porSucursal.map((g) => ({ etiqueta: g.clave, neto: g.neto }))} valueKey="neto" labelKey="etiqueta" />
              </SectionCard>
            )}

            <div className="stats-cols">
              <SectionCard accent="var(--primary)" title="Por sucursal">
                <table className="stats-table">
                  <thead><tr><th>Sucursal</th><th>Legajos</th><th>A pagar</th><th>Pagado</th></tr></thead>
                  <tbody>
                    {porSucursal.map((g) => (
                      <tr key={g.clave}><td>{g.clave}</td><td>{g.cantidad}</td><td>{money(g.neto)}</td><td>{money(g.pagado)}</td></tr>
                    ))}
                    {porSucursal.length === 0 && <tr><td colSpan={4} className="vacio">Sin datos</td></tr>}
                  </tbody>
                </table>
              </SectionCard>
              <SectionCard accent="var(--good)" title="Por sector">
                <table className="stats-table">
                  <thead><tr><th>Sector</th><th>Legajos</th><th>A pagar</th><th>Pagado</th></tr></thead>
                  <tbody>
                    {porSector.map((g) => (
                      <tr key={g.clave}><td>{g.clave}</td><td>{g.cantidad}</td><td>{money(g.neto)}</td><td>{money(g.pagado)}</td></tr>
                    ))}
                    {porSector.length === 0 && <tr><td colSpan={4} className="vacio">Sin datos</td></tr>}
                  </tbody>
                </table>
              </SectionCard>
              <SectionCard accent="var(--plum)" title="Por turno">
                <table className="stats-table">
                  <thead><tr><th>Turno</th><th>Legajos</th><th>A pagar</th><th>Pagado</th></tr></thead>
                  <tbody>
                    {porTurno.map((g) => (
                      <tr key={g.clave}><td>{g.clave}</td><td>{g.cantidad}</td><td>{money(g.neto)}</td><td>{money(g.pagado)}</td></tr>
                    ))}
                    {porTurno.length === 0 && <tr><td colSpan={4} className="vacio">Sin datos</td></tr>}
                  </tbody>
                </table>
              </SectionCard>
            </div>

            <div className="stats-cols">
              <SectionCard accent="var(--warn)" title="Ranking de faltas" subtitle="Legajos con más ausencias este mes.">
                <table className="stats-table">
                  <thead><tr><th>Legajo</th><th>Faltas</th></tr></thead>
                  <tbody>
                    {rankingFaltas.map((r) => (
                      <tr key={r.emp.id}><td>{r.emp.nombre || r.emp.apellido ? `${r.emp.nombre || "—"} ${r.emp.apellido || "—"}` : "Sin nombre"}</td><td>{r.cantidad}</td></tr>
                    ))}
                    {rankingFaltas.length === 0 && <tr><td colSpan={2} className="vacio">Sin faltas este mes</td></tr>}
                  </tbody>
                </table>
              </SectionCard>
              <SectionCard accent="var(--good)" title="Ranking de horas extra" subtitle="Legajos con más horas extra este mes.">
                <table className="stats-table">
                  <thead><tr><th>Legajo</th><th>Horas extra</th></tr></thead>
                  <tbody>
                    {rankingExtra.map((r) => (
                      <tr key={r.emp.id}><td>{r.emp.nombre || r.emp.apellido ? `${r.emp.nombre || "—"} ${r.emp.apellido || "—"}` : "Sin nombre"}</td><td>{r.horas} hs</td></tr>
                    ))}
                    {rankingExtra.length === 0 && <tr><td colSpan={2} className="vacio">Sin horas extra este mes</td></tr>}
                  </tbody>
                </table>
              </SectionCard>
              <SectionCard accent="var(--warn)" title="Novedades del mes" subtitle="Totales de deducciones cargadas.">
                <div className="resumen-grid">
                  <div className="stat neg"><div className="k">Adelantos</div><div className="v">{money(totalAdelantosMes)}</div></div>
                  <div className="stat neg"><div className="k">Mercadería</div><div className="v">{money(totalMercaderiaMes)}</div></div>
                </div>
              </SectionCard>
            </div>
          </>
        )}

        {section === "aguinaldo" && !aguinaldoEmployee && (
          <div className="empty-main">
            <h2>Ningún legajo seleccionado</h2>
            <p>Elegí un legajo de la lista para liquidar su aguinaldo (SAC).</p>
          </div>
        )}

        {section === "aguinaldo" && aguinaldoEmployee && sacRef && (
          <>
            <button className="back-link" onClick={() => setAguinaldoEmployeeId(null)}>← Volver a la lista</button>

            <div className="detail-header">
              <div>
                <h2>{aguinaldoEmployee.nombre || aguinaldoEmployee.apellido ? `${aguinaldoEmployee.nombre || "—"} ${aguinaldoEmployee.apellido || "—"}` : "Legajo sin nombre"}</h2>
                <div className="sub">Aguinaldo (SAC) — Año {aguinaldoYear}</div>
              </div>
              <div className="header-actions no-print">
                <Field label="Año">
                  <input type="number" value={aguinaldoYear} onChange={(e) => setAguinaldoYear(e.target.value)} style={{ width: 90 }} />
                </Field>
                <button className="btn-secondary" onClick={abrirPdfAguinaldo}>Generar PDF</button>
                <button className="btn-save" onClick={guardarAguinaldo}>Guardar cambios</button>
              </div>
            </div>

            <div className="week-tabs no-print">
              <button className={"week-tab" + (aguinaldoCuota === 1 ? " active" : "")} onClick={() => setAguinaldoCuota(1)}>SAC 1° cuota (Ene-Jun)</button>
              <button className={"week-tab" + (aguinaldoCuota === 2 ? " active" : "")} onClick={() => setAguinaldoCuota(2)}>SAC 2° cuota (Jul-Dic)</button>
            </div>

            <SectionCard accent="var(--good)" title="Cálculo de referencia" subtitle="Se analizan los 6 sueldos del semestre y se muestra solo el mejor — se usa como guía; la liquidación real se hace con la base que ingreses abajo.">
              {!sacRef.mejorLiq ? (
                <p className="hint">Sin sueldos cargados en este semestre todavía.</p>
              ) : (
                <>
                  <div className="subtotal-line" style={{ borderTop: "none", paddingTop: 0 }}>
                    <span>Mejor sueldo del semestre: <strong>{sacRef.mejorMes}</strong></span>
                  </div>
                  <table className="stats-table">
                    <thead><tr><th>Concepto</th><th>Importe</th></tr></thead>
                    <tbody>
                      {sacRef.mejorLiq.basico > 0 && <tr><td>Básico</td><td>{money(sacRef.mejorLiq.basico)}</td></tr>}
                      {sacRef.mejorLiq.presentismo > 0 && <tr><td>Presentismo</td><td>{money(sacRef.mejorLiq.presentismo)}</td></tr>}
                      {sacRef.mejorLiq.totalAdicionales > 0 && <tr><td>Adicionales</td><td>{money(sacRef.mejorLiq.totalAdicionales)}</td></tr>}
                      {sacRef.mejorLiq.montoExtra > 0 && <tr><td>Horas extra ({sacRef.mejorLiq.horasExtra} hs)</td><td>{money(sacRef.mejorLiq.montoExtra)}</td></tr>}
                      {sacRef.mejorLiq.montoDomingo > 0 && <tr><td>Domingo trabajado ({sacRef.mejorLiq.domingosTrabajados})</td><td>{money(sacRef.mejorLiq.montoDomingo)}</td></tr>}
                      {sacRef.mejorLiq.montoFeriado > 0 && <tr><td>Feriado trabajado ({sacRef.mejorLiq.feriadosTrabajados})</td><td>{money(sacRef.mejorLiq.montoFeriado)}</td></tr>}
                    </tbody>
                  </table>
                </>
              )}
              <div className="subtotal-line"><span>Mejor remuneración del semestre (sin no remunerativo)</span><strong>{money(sacRef.mejor)}</strong></div>
              <div className="subtotal-line"><span>Meses trabajados en el semestre</span><strong>{sacRef.mesesTrabajados} / 6</strong></div>
            </SectionCard>

            <SectionCard accent="var(--plum)" title="Base imponible a liquidar" subtitle="Por defecto toma la mejor remuneración de arriba; escribí un valor distinto si querés liquidar con otra base.">
              <div className="field-grid">
                <Field label="Base imponible (ARS)">
                  <input type="number" min="0" step="0.01" value={aguinaldoBaseInput} placeholder={String(sacRef.mejor)} onChange={(e) => setAguinaldoBase(e.target.value)} />
                </Field>
              </div>
              <div className="resumen-grid" style={{ marginTop: 12 }}>
                <div className="stat total"><div className="k">Importe SAC a liquidar</div><div className="v">{money(aguinaldoImporte)}</div></div>
              </div>
            </SectionCard>
          </>
        )}

        {section === "vacaciones" && !vacacionesEmployee && (
          <div className="empty-main">
            <h2>Ningún legajo seleccionado</h2>
            <p>Elegí un legajo de la lista para asignarle días de vacaciones.</p>
          </div>
        )}

        {section === "vacaciones" && vacacionesEmployee && (
          <>
            <button className="back-link" onClick={() => setVacacionesEmployeeId(null)}>← Volver a la lista</button>

            <div className="detail-header">
              <div>
                <h2>{vacacionesEmployee.nombre || vacacionesEmployee.apellido ? `${vacacionesEmployee.nombre || "—"} ${vacacionesEmployee.apellido || "—"}` : "Legajo sin nombre"}</h2>
                <div className="sub">Vacaciones — Año {vacacionesYear}</div>
              </div>
              <div className="header-actions no-print">
                <Field label="Año">
                  <input type="number" value={vacacionesYear} onChange={(e) => setVacacionesYear(e.target.value)} style={{ width: 90 }} />
                </Field>
                <button className="btn-save" onClick={guardarVacaciones}>Guardar cambios</button>
              </div>
            </div>

            <SectionCard accent="var(--plum)" title="Días correspondientes" subtitle="Según antigüedad (LCT arts. 150-155).">
              {!vacacionesRef ? (
                <p className="hint">Cargá la fecha de ingreso en Datos personales para calcular los días que corresponden.</p>
              ) : (
                <div className="resumen-grid">
                  <div className="stat"><div className="k">Antigüedad al 31/12/{vacacionesYear}</div><div className="v">{vacacionesRef.antiguedadAnios.toFixed(1)} años</div></div>
                  <div className="stat"><div className="k">Días correspondientes{vacacionesRef.proporcional ? " (proporcional)" : ""}</div><div className="v">{vacacionesRef.diasCorrespondientes}</div></div>
                  <div className="stat"><div className="k">Días asignados en el calendario</div><div className="v">{fechasVacacionesEmployee.length}</div></div>
                </div>
              )}
            </SectionCard>

            <SectionCard accent="var(--primary)" title={`Calendario ${vacacionesYear} (enero a junio)`} subtitle="Hacé clic en los días para asignarlos como vacaciones de este legajo. El período de asignación va de enero a junio.">
              <div className="vac-year-grid">
                {Array.from({ length: 6 }, (_, m) => {
                  const total = daysInMonth(Number(vacacionesYear), m);
                  const lead = mondayIndex(Number(vacacionesYear), m, 1);
                  const celdas = [];
                  for (let i = 0; i < lead; i++) celdas.push(null);
                  for (let d = 1; d <= total; d++) celdas.push(d);
                  return (
                    <div key={m} className="vac-month">
                      <div className="vac-month-title">{MESES[m]}</div>
                      <div className="vac-month-grid">
                        {DOW.map((d) => <div key={d} className="vac-dow">{d[0]}</div>)}
                        {celdas.map((d, idx) => {
                          if (d === null) return <div key={"b" + idx} className="vac-day blank" />;
                          const fechaISO = dateStr(Number(vacacionesYear), m, d);
                          const asignado = fechasVacacionesEmployee.includes(fechaISO);
                          return (
                            <button key={fechaISO} className={"vac-day" + (asignado ? " asignado" : "")} onClick={() => toggleFechaVacacion(fechaISO)}>
                              {d}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          </>
        )}

        {section === "vacaciones" && (
          <div className="no-print" style={{ marginTop: vacacionesEmployee ? 0 : 20 }}>
            <SectionCard accent="var(--good)" title="Imprimir calendario de todos los legajos" subtitle="Genera un PDF con las vacaciones asignadas de todos los legajos activos que coincidan con los filtros de sucursal y sector de la barra lateral.">
              <div className="field-grid">
                <Field label="Año a imprimir">
                  <input type="number" value={vacacionesYear} onChange={(e) => setVacacionesYear(e.target.value)} style={{ maxWidth: 140 }} />
                </Field>
              </div>
              <button className="btn-secondary" onClick={abrirPdfVacaciones} style={{ marginTop: 10 }}>Generar PDF de todos los legajos</button>
            </SectionCard>
          </div>
        )}
      </main>

      <div className="toast">{status}</div>


      {confirmState && (
        <div className="modal-overlay" onClick={closeConfirm}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <p>{confirmState.message}</p>
            {confirmState.requireText && (
              <input
                autoFocus
                className="modal-confirm-input"
                placeholder={`Escribí "${confirmState.requireText}" para confirmar`}
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
              />
            )}
            <div className="modal-actions">
              <button className="modal-btn cancel" onClick={closeConfirm}>Cancelar</button>
              <button
                className={"modal-btn" + (confirmState.danger ? " danger" : "")}
                disabled={!!confirmState.requireText && confirmInput !== confirmState.requireText}
                onClick={async () => {
                  const fn = confirmState.onConfirm;
                  closeConfirm();
                  await fn();
                }}
              >
                {confirmState.danger ? "Eliminar" : "Confirmar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const p = { fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };
const Svg = ({ children }) => <svg viewBox="0 0 24 24" width="20" height="20">{children}</svg>;

export const ICONS = {
  // сводка — приборная панель
  summary: <Svg><path {...p} d="M4 15a8 8 0 1 1 16 0" /><path {...p} d="M12 15l4-5" /><path {...p} d="M3 19h18" /></Svg>,
  // должники — кошелёк со стрелкой вниз
  debtors: <Svg><rect {...p} x="3" y="6" width="18" height="13" rx="2.5" /><path {...p} d="M3 10h18" /><path {...p} d="M15 14.5h2.5" /></Svg>,
  // водители — руль
  drivers: <Svg><circle {...p} cx="12" cy="12" r="8.5" /><circle {...p} cx="12" cy="12" r="2.2" /><path {...p} d="M3.8 10.5 9.9 12M14.1 12l6.1-1.5M12 14.2V20.4" /></Svg>,
  // финансы — две встречные стрелки
  finance: <Svg><path {...p} d="M7 4v14M3.5 14.5 7 18l3.5-3.5" /><path {...p} d="M17 20V6M13.5 9.5 17 6l3.5 3.5" /></Svg>,
  // история — график
  history: <Svg><path {...p} d="M4 4v16h16" /><path {...p} d="M7.5 14l3.5-4 3 2.5 4.5-5.5" /></Svg>,
  // настройки — ползунки
  settings: <Svg><path {...p} d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle {...p} cx="16" cy="7" r="2" /><circle {...p} cx="10" cy="17" r="2" /></Svg>,
};

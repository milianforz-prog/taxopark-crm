// Подсказка «Установите приложение» внизу экрана входа.
// В уже установленном приложении (standalone) не показывается.

const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(ua);
const isStandalone = typeof window !== "undefined"
  && (window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true);

function ShareIcon() {
  return (
    <svg className="ios-share" viewBox="0 0 24 24" aria-label="Поделиться">
      <path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M8 10H6.5A1.5 1.5 0 0 0 5 11.5v8A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-8A1.5 1.5 0 0 0 17.5 10H16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function PlusSquare() {
  return (
    <svg className="ios-share" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 8.5v7M8.5 12h7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export default function InstallHint() {
  if (isStandalone) return null;
  const showIOS = isIOS || !isAndroid;
  const showAndroid = isAndroid || !isIOS;
  return (
    <section className="install" aria-label="Установка приложения">
      <div className="install-head">
        <img src="./apple-touch-icon.png" alt="" width="40" height="40" />
        <div>
          <b>Приложение на телефон</b>
          <span>Иконка на экране «Домой», открывается без адресной строки</span>
        </div>
      </div>

      {showIOS && (
        <div className="install-os">
          {!isIOS || showAndroid ? <div className="install-os-name">iPhone</div> : null}
          <ol>
            <li>Откройте этот сайт в <b>Safari</b></li>
            <li>Нажмите <ShareIcon /> <b>«Поделиться»</b> внизу экрана</li>
            <li>Выберите <PlusSquare /> <b>«На экран „Домой“»</b></li>
            <li>Нажмите <b>«Добавить»</b> в правом верхнем углу</li>
          </ol>
        </div>
      )}

      {showAndroid && (
        <div className="install-os">
          {!isAndroid || showIOS ? <div className="install-os-name">Android</div> : null}
          <ol>
            <li>Откройте сайт в <b>Chrome</b></li>
            <li>Нажмите <b>⋮</b> в правом верхнем углу</li>
            <li>Выберите <b>«Добавить на главный экран»</b> или <b>«Установить приложение»</b></li>
          </ol>
        </div>
      )}
    </section>
  );
}

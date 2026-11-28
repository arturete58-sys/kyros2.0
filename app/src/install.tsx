/**
 * Installing Kyros as an app from the browser (no app store).
 *
 * Chrome, Edge and Android offer an install prompt (`beforeinstallprompt`),
 * which is caught as early as possible and shown as a button. iPhone and iPad
 * have no prompt: Safari installs through Share → Add to Home Screen, so the
 * card explains that instead. Nothing shows once Kyros runs as an installed
 * app, or after the visitor closes the card.
 */
import { useEffect, useRef, useState } from 'react';
import { t } from './i18n';

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> };

let deferred: PromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

/** Called from main.tsx before React renders, so an early prompt is not lost. */
export function watchInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e as PromptEvent;
    notify();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    notify();
  });
}

const DISMISSED = 'kyros.install.dismissed';

function installed(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

function iosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
}

/** The install card. `always` keeps it visible after being closed (Settings). */
export function InstallCard({ always = false }: { always?: boolean }) {
  const [, setTick] = useState(0);
  const [closed, setClosed] = useState(() => !always && localStorage.getItem(DISMISSED) === '1');
  const ref = useRef<HTMLDivElement>(null);
  // A link from the website (…/app/#install) opens the card even if it was closed before, and shows it.
  const asked = location.hash === '#install';
  useEffect(() => {
    if (asked) ref.current?.scrollIntoView({ block: 'center' });
  }, [asked]);
  useEffect(() => {
    const f = () => setTick((n) => n + 1);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  if (installed() || (closed && !asked)) return null;
  const ios = iosSafari();
  if (!deferred && !ios) return null;
  const close = () => {
    localStorage.setItem(DISMISSED, '1');
    setClosed(true);
  };
  return (
    <div className="card info" data-testid="install-card" ref={ref}>
      <div className="row spread">
        <b className="small">{t('installTitle')}</b>
        {!always && (
          <button className="link tiny" onClick={close} aria-label={t('installClose')}>
            {t('installClose')}
          </button>
        )}
      </div>
      {ios ? (
        <p className="tiny" dangerouslySetInnerHTML={{ __html: t('installIos') }} />
      ) : (
        <>
          <p className="tiny muted">{t('installBody')}</p>
          <button
            className="btn secondary small"
            data-testid="install-button"
            onClick={async () => {
              const e = deferred;
              if (!e) return;
              await e.prompt();
              await e.userChoice.catch(() => undefined);
              deferred = null;
              notify();
            }}
          >
            {t('installButton')}
          </button>
        </>
      )}
    </div>
  );
}

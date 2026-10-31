import { createRoot } from 'react-dom/client';
import { App } from './App';
import { api } from './api';
import { AppProvider } from './state';
import './styles.css';

async function boot() {
  const root = createRoot(document.getElementById('root')!);
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const [{ createTauriPlatform }, { createAppApi }] = await Promise.all([import('./platform-tauri'), import('./appApi')]);
      const { platform, shell, testMode } = await createTauriPlatform();
      window.api = await createAppApi(platform, shell, testMode);
    } else if (import.meta.env.DEV) {
      // У звичайному браузері (npm run dev:ui) нативного шару немає — підставляємо імітацію.
      window.api = (await import('./mock')).mockApi;
    }
    const init = await api().init();
    root.render(
      <AppProvider init={init}>
        <App />
      </AppProvider>,
    );
  } catch (e) {
    root.render(<div className="fatal">Не вдалося запустити програму: {String(e)}</div>);
  }
}

void boot();

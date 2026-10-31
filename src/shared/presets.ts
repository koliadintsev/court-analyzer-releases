import type { AiField, AppSettings, Column, MetaColumnId, Profile, ProviderId } from './types';

export const PROVIDERS: Record<ProviderId, { title: string; keyHint: string; keyUrl: string }> = {
  openai: { title: 'OpenAI', keyHint: 'sk-…', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { title: 'Anthropic (Claude)', keyHint: 'sk-ant-…', keyUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { title: 'Google Gemini', keyHint: 'AIza…', keyUrl: 'https://aistudio.google.com/apikey' },
  compatible: { title: 'OpenAI-сумісний (OpenRouter, Ollama…)', keyHint: 'ключ провайдера (може бути порожнім для локальних моделей)', keyUrl: '' },
};

/** Підказки моделей; актуальний список підтягується з API кнопкою «Перевірити ключ». */
export const MODEL_SUGGESTIONS: Record<ProviderId, string[]> = {
  openai: ['gpt-5-mini', 'gpt-5', 'gpt-4.1-mini', 'gpt-4.1'],
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  gemini: ['gemini-flash-latest', 'gemini-pro-latest', 'gemini-flash-lite-latest'],
  compatible: [],
};

export const DEFAULT_SETTINGS: AppSettings = {
  ai: {
    filter: { provider: 'gemini', model: 'gemini-flash-latest' },
    extract: { provider: 'gemini', model: 'gemini-pro-latest' },
    concurrency: 3,
    maxInputChars: 300_000,
    compatibleBaseUrl: 'https://openrouter.ai/api/v1',
  },
  textConcurrency: 4,
  activeProfileId: '',
};

const ALL_META: MetaColumnId[] = [
  'adjudication_date',
  'cause_num',
  'instance',
  'court',
  'judgment_form',
  'justice_kind',
  'category',
  'judge',
  'region',
  'receipt_date',
  'date_publ',
  'doc_id',
  'relevance_reason',
  'link',
];

function meta(ids: MetaColumnId[], enabled: MetaColumnId[]): Column[] {
  return ids.map((id) => ({ kind: 'meta', id, enabled: enabled.includes(id) }));
}

/** Збирає список колонок: метадані на початку, поля ШІ, потім решта метаданих і посилання. */
function columns(lead: MetaColumnId[], ai: Column[], enabled: MetaColumnId[]): Column[] {
  const rest = ALL_META.filter((id) => !lead.includes(id) && id !== 'link');
  return [...meta(lead, enabled), ...ai, ...meta(rest, enabled), ...meta(['link'], enabled)];
}

function ai(id: string, title: string, type: AiField['type'], instruction: string, opts: { enabled?: boolean; options?: string[] } = {}): Column {
  return { kind: 'ai', enabled: opts.enabled ?? true, field: { id, title, type, instruction, ...(opts.options && { options: opts.options }) } };
}

const NO_FILTERS = { judgmentForms: [], justiceKinds: [], instances: [], dateFrom: '', dateTo: '' };

export const TEMPLATES: Profile[] = [
  {
    id: 'tpl-base',
    name: 'Базовий аналіз судових рішень',
    filters: {
      ...NO_FILTERS,
      minTextLength: 3000,
      aiFilterEnabled: false,
      aiCriterion: '',
      aiFilterInstructions: '',
    },
    extraction: {
      enabled: true,
      role: 'Ти — досвідчений юрист-аналітик судової практики України.',
      instructions:
        'Мета аналізу — систематизувати судову практику: для кожного рішення важливо зафіксувати, хто з ким і про що сперечався, чим закінчився спір і які правові позиції сформулював суд.\n' +
        'У кримінальних провадженнях позивачем вважай сторону обвинувачення (прокурора), відповідачем — обвинуваченого.',
      unknownValue: 'невідомо',
    },
    columns: columns(
      ['adjudication_date', 'cause_num', 'court', 'instance', 'judgment_form'],
      [
        ai('claimant', 'Позивач', 'text', 'Особа, яка звернулася до суду з первісною вимогою (позивач, заявник): повна назва юридичної особи або ПІБ фізичної особи, як у тексті.'),
        ai('defendant', 'Відповідач', 'text', 'Особа, до якої пред’явлено вимогу, зокрема суб’єкт владних повноважень, рішення, дії чи бездіяльність якого оскаржуються.'),
        ai(
          'subject',
          'Предмет спору',
          'text',
          'Що саме вимагав позивач — одним реченням (наприклад: «визнання протиправним і скасування податкового повідомлення-рішення», «стягнення заборгованості за договором поставки»).',
        ),
        ai('claim_amount', 'Сума вимог, грн', 'number', 'Сума позовних вимог або оспорюваного зобов’язання в гривнях, якщо вона зазначена в тексті.'),
        ai(
          'outcome',
          'Результат розгляду',
          'enum',
          'Що вирішив цей суд — за резолютивною частиною. Для першої інстанції — результат щодо позову; для апеляції чи касації — що сталося з рішенням попередньої інстанції.',
          {
            options: [
              'задоволено повністю',
              'задоволено частково',
              'відмовлено',
              'залишено без розгляду / провадження закрито',
              'рішення попередньої інстанції залишено без змін',
              'рішення попередньої інстанції скасовано або змінено',
              'справу направлено на новий розгляд',
              'інше',
            ],
          },
        ),
        ai(
          'winner',
          'На чию користь',
          'enum',
          'На чию користь у підсумку вирішено спір цим рішенням. «частково» — якщо вимоги задоволено частково; «новий розгляд» — якщо справу направлено на новий розгляд.',
          { options: ['позивача', 'відповідача', 'частково', 'новий розгляд'] },
        ),
        ai('legal_norms', 'Ключові норми', 'list', 'До 7 найважливіших норм права, на яких суд ґрунтує висновки, у форматі «ст. 39 ПКУ», «ч. 2 ст. 77 КАС України».'),
        ai(
          'legal_position',
          'Правова позиція суду',
          'long_text',
          'Узагальнений правовий висновок суду, корисний для подібних справ (1–3 речення). Якщо суд прямо формулює висновок щодо застосування норми права (зокрема Верховний Суд), передай саме його.',
        ),
        ai('summary', 'Суть справи', 'long_text', 'Стислий виклад у 4–6 реченнях: обставини справи, вимоги позивача, основні доводи сторін і висновок суду з ключовими мотивами.'),
        ai('keywords', 'Ключові слова', 'list', '3–7 ключових термінів, що описують предмет і правову проблематику спору.'),
        ai('claimant_position', 'Доводи позивача', 'long_text', 'Основні доводи позивача (заявника, скаржника) у 2–3 реченнях.', { enabled: false }),
        ai('defendant_position', 'Доводи відповідача', 'long_text', 'Основні доводи відповідача у 2–3 реченнях.', { enabled: false }),
        ai('lower_courts', 'Попередні інстанції', 'long_text', 'Що вирішили суди попередніх інстанцій (для апеляції та касації), 1–2 реченнями.', { enabled: false }),
        ai(
          'precedents',
          'Посилання на практику',
          'list',
          'Рішення Верховного Суду, Конституційного Суду чи ЄСПЛ, на правові висновки яких посилається суд (номер справи або назва та дата рішення).',
          { enabled: false },
        ),
      ],
      ['adjudication_date', 'cause_num', 'court', 'instance', 'judgment_form', 'link'],
    ),
  },
];

/** Шаблони, на які посилаються профілі зі старих версій програми. */
const TEMPLATE_ALIASES: Record<string, string> = { 'tpl-generic': 'tpl-base' };

export function templateFor(profile: Profile): Profile | undefined {
  const id = profile.templateId && (TEMPLATE_ALIASES[profile.templateId] ?? profile.templateId);
  return TEMPLATES.find((t) => t.id === id);
}

/**
 * Відбитки вмісту попередніх версій шаблонів. Профіль, який користувач не змінював
 * (відбиток збігається), автоматично оновлюється до актуальної версії шаблону.
 */
export const LEGACY_TEMPLATE_HASHES: Record<string, string[]> = {
  'tpl-generic': ['c5e9e17a'],
};

/** FNV-1a від фільтрів, полів та інструкцій профілю. */
export function profileContentHash(p: Pick<Profile, 'filters' | 'extraction' | 'columns'>): string {
  const s = JSON.stringify({ filters: p.filters, extraction: p.extraction, columns: p.columns });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Оновлює вміст профілю з актуального шаблону, зберігаючи ідентифікатор і назву. */
export function refreshFromTemplate(profile: Profile, tpl: Profile, name = profile.name): Profile {
  const copy: Profile = JSON.parse(JSON.stringify(tpl));
  return { ...copy, id: profile.id, name, templateId: tpl.id };
}

export function newId(prefix = 'p'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export function profileFromTemplate(tpl: Profile, name?: string): Profile {
  const copy: Profile = JSON.parse(JSON.stringify(tpl));
  copy.id = newId('profile');
  copy.templateId = tpl.id;
  copy.name = name ?? tpl.name;
  return copy;
}

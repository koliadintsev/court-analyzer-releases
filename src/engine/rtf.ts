// Перетворення RTF у простий текст (аналог Python-бібліотеки striprtf)
// з декодуванням кириличних \'xx-послідовностей за кодовою сторінкою документа.

const DESTINATIONS = new Set([
  'aftncn', 'aftnsep', 'aftnsepc', 'annotation', 'atnauthor', 'atndate', 'atnicn', 'atnid', 'atnparent', 'atnref', 'atntime',
  'atrfend', 'atrfstart', 'author', 'background', 'bkmkend', 'bkmkstart', 'blipuid', 'buptim', 'category', 'colorschememapping',
  'colortbl', 'comment', 'company', 'creatim', 'datafield', 'datastore', 'defchp', 'defpap', 'do', 'doccomm', 'docvar', 'dptxbxtext',
  'ebcend', 'ebcstart', 'factoidname', 'falt', 'fchars', 'ffdeftext', 'ffentrymcr', 'ffexitmcr', 'ffformat', 'ffhelptext', 'ffl',
  'ffname', 'ffstattext', 'field', 'file', 'filetbl', 'fldinst', 'fldtype', 'fname', 'fontemb', 'fontfile', 'fonttbl',
  'footer', 'footerf', 'footerl', 'footerr', 'footnote', 'formfield', 'ftncn', 'ftnsep', 'ftnsepc', 'g', 'generator', 'gridtbl',
  'header', 'headerf', 'headerl', 'headerr', 'hl', 'hlfr', 'hlinkbase', 'hlloc', 'hlsrc', 'hsv', 'htmltag', 'info', 'keycode',
  'keywords', 'latentstyles', 'lchars', 'levelnumbers', 'leveltext', 'lfolevel', 'linkval', 'list', 'listlevel', 'listname',
  'listoverride', 'listoverridetable', 'listpicture', 'liststylename', 'listtable', 'listtext', 'lsdlockedexcept', 'macc', 'maccPr',
  'mailmerge', 'maln', 'malnScr', 'manager', 'margPr', 'mbar', 'mbarPr', 'mbaseJc', 'mbegChr', 'mborderBox', 'mborderBoxPr', 'mbox',
  'mboxPr', 'mchr', 'mcount', 'mctrlPr', 'md', 'mdeg', 'mdegHide', 'mden', 'mdiff', 'mdPr', 'me', 'mendChr', 'meqArr', 'meqArrPr',
  'mf', 'mfName', 'mfPr', 'mfunc', 'mfuncPr', 'mgroupChr', 'mgroupChrPr', 'mgrow', 'mhideBot', 'mhideLeft', 'mhideRight', 'mhideTop',
  'mhtmltag', 'mlim', 'mlimloc', 'mlimlow', 'mlimlowPr', 'mlimupp', 'mlimuppPr', 'mm', 'mmaddfieldname', 'mmath', 'mmathPict',
  'mmathPr', 'mmaxdist', 'mmc', 'mmcJc', 'mmconnectstr', 'mmconnectstrdata', 'mmcPr', 'mmcs', 'mmdatasource', 'mmheadersource',
  'mmmailsubject', 'mmodso', 'mmodsofilter', 'mmodsofldmpdata', 'mmodsomappedname', 'mmodsoname', 'mmodsorecipdata', 'mmodsosort',
  'mmodsosrc', 'mmodsotable', 'mmodsoudl', 'mmodsoudldata', 'mmodsouniquetag', 'mmPr', 'mmquery', 'mmr', 'mnary', 'mnaryPr',
  'mnoBreak', 'mnum', 'mobjDist', 'moMath', 'moMathPara', 'moMathParaPr', 'mopEmu', 'mphant', 'mphantPr', 'mplcHide', 'mpos', 'mr',
  'mrad', 'mradPr', 'mrPr', 'msepChr', 'mshow', 'mshp', 'msPre', 'msPrePr', 'msSub', 'msSubPr', 'msSubSup', 'msSubSupPr', 'msSup',
  'msSupPr', 'mstrikeBLTR', 'mstrikeH', 'mstrikeTLBR', 'mstrikeV', 'msub', 'msubHide', 'msup', 'msupHide', 'mtransp', 'mtype',
  'mvertJc', 'mvfmf', 'mvfml', 'mvtof', 'mvtol', 'mzeroAsc', 'mzeroDesc', 'mzeroWid', 'nesttableprops', 'nextfile', 'nonesttables',
  'objalias', 'objclass', 'objdata', 'object', 'objname', 'objsect', 'objtime', 'oldcprops', 'oldpprops', 'oldsprops', 'oldtprops',
  'oleclsid', 'operator', 'panose', 'password', 'passwordhash', 'pgp', 'pgptbl', 'picprop', 'pict', 'pn', 'pnseclvl', 'pntext',
  'pntxta', 'pntxtb', 'printim', 'private', 'propname', 'protend', 'protstart', 'protusertbl', 'pxe', 'result', 'revtbl', 'revtim',
  'rsidtbl', 'rxe', 'shp', 'shpgrp', 'shpinst', 'shppict', 'shprslt', 'shptxt', 'sn', 'sp', 'staticval', 'stylesheet', 'subject',
  'sv', 'svb', 'tc', 'template', 'themedata', 'title', 'txe', 'ud', 'upr', 'userprops', 'wgrffmtfilter', 'windowcaption', 'writereservation',
  'writereservhash', 'xe', 'xform', 'xmlattrname', 'xmlattrvalue', 'xmlclose', 'xmlname', 'xmlnstbl', 'xmlopen',
]);

const SPECIAL: Record<string, string> = {
  par: '\n',
  sect: '\n\n',
  page: '\n\n',
  line: '\n',
  row: '\n',
  nestrow: '\n',
  cell: ' ',
  nestcell: ' ',
  tab: '\t',
  emdash: '—',
  endash: '–',
  emspace: ' ',
  enspace: ' ',
  qmspace: ' ',
  bullet: '•',
  lquote: '‘',
  rquote: '’',
  ldblquote: '“',
  rdblquote: '”',
};

const TOKEN = /\\([a-z]{1,32})(-?\d{1,10})?[ ]?|\\'([0-9a-f]{2})|\\([^a-z])|([{}])|[\r\n]+|([\s\S])/gi;

function decoderFor(codepage: number): TextDecoder {
  // Українські рішення інколи позначені як 1252, хоча фактично в cp1251 —
  // так само робив попередній скрипт.
  const cp = codepage === 1252 || !codepage ? 1251 : codepage;
  try {
    return new TextDecoder(`windows-${cp}`);
  } catch {
    return new TextDecoder('windows-1251');
  }
}

/** Байти як рядок ISO-8859-1 (кожен байт — один символ). */
export function latin1(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return s;
}

export function rtfToText(input: Uint8Array | string): string {
  const rtf = typeof input === 'string' ? input : latin1(input);
  const cpMatch = /\\ansicpg(\d+)/.exec(rtf.slice(0, 2000));
  const decoder = decoderFor(cpMatch ? Number(cpMatch[1]) : 1251);

  const stack: { ucskip: number; ignorable: boolean }[] = [];
  let ignorable = false;
  let ucskip = 1;
  let curskip = 0;
  const out: string[] = [];
  let bytes: number[] = [];

  const flush = () => {
    if (bytes.length) {
      out.push(decoder.decode(Uint8Array.from(bytes)));
      bytes = [];
    }
  };

  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(rtf))) {
    const [, word, arg, hex, char, brace, tchar] = m;
    if (hex !== undefined) {
      if (curskip > 0) curskip--;
      else if (!ignorable) bytes.push(parseInt(hex, 16));
      continue;
    }
    if (tchar !== undefined) {
      if (curskip > 0) {
        curskip--;
        continue;
      }
      if (ignorable) continue;
      const code = tchar.charCodeAt(0);
      if (code > 127 && code < 256) bytes.push(code);
      else {
        flush();
        out.push(tchar);
      }
      continue;
    }
    flush();
    if (brace !== undefined) {
      curskip = 0;
      if (brace === '{') stack.push({ ucskip, ignorable });
      else if (stack.length) ({ ucskip, ignorable } = stack.pop()!);
    } else if (char !== undefined) {
      curskip = 0;
      if (char === '~') {
        if (!ignorable) out.push(' ');
      } else if ('{}\\'.includes(char)) {
        if (!ignorable) out.push(char);
      } else if (char === '*') {
        ignorable = true;
      } else if (char === '-' || char === '_') {
        if (!ignorable && char === '_') out.push('-');
      }
    } else if (word !== undefined) {
      curskip = 0;
      if (DESTINATIONS.has(word)) ignorable = true;
      else if (ignorable) continue;
      else if (SPECIAL[word] !== undefined) out.push(SPECIAL[word]);
      else if (word === 'uc') ucskip = Number(arg ?? 1);
      else if (word === 'u') {
        let c = Number(arg ?? 0);
        if (c < 0) c += 0x10000;
        out.push(String.fromCharCode(c));
        curskip = ucskip;
      }
    }
  }
  flush();

  return out
    .join('')
    .replace(/ /g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Текст з HTML-сторінки (запасний варіант, якщо замість RTF прийшов HTML). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

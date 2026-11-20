// An answer written for Chat, rewritten to be read aloud by a speaker in its language. Speech voices
// read "40°F" as "40 F", so temperatures, percentages and numbers are written out in words, the way the
// voice bridge writes its own answers: 華氏四十度, 百分之三十, bốn mươi độ F.
import { spokenDegrees } from './questions';
import type { QuestionLang } from './native-questions';

const DIGITS = '零一二三四五六七八九';

/** A number as written to be read in Chinese: 二, 十二, 四十五, 一百零五, 零下三. */
export function chineseNumber(n: number): string {
  if (n < 0) return '零下' + chineseNumber(-n);
  if (n < 10) return DIGITS[n];
  if (n < 100) {
    const tens = Math.floor(n / 10), units = n % 10;
    return (tens === 1 ? '' : DIGITS[tens]) + '十' + (units ? DIGITS[units] : '');
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100), rest = n % 100;
    const tail = !rest ? '' : rest < 10 ? '零' + DIGITS[rest] : (rest < 20 ? '一' : '') + chineseNumber(rest);
    return DIGITS[hundreds] + '百' + tail;
  }
  return String(n);
}

const VI_UNITS = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];

/** A number as said in Vietnamese: "mười lăm", "bốn mươi mốt", "âm hai". */
export function vietnameseNumber(n: number): string {
  if (n < 0) return 'âm ' + vietnameseNumber(-n);
  if (n < 10) return VI_UNITS[n];
  if (n < 20) return 'mười' + (n === 10 ? '' : n === 15 ? ' lăm' : ` ${VI_UNITS[n - 10]}`);
  if (n < 100) {
    const tens = Math.floor(n / 10), units = n % 10;
    return `${VI_UNITS[tens]} mươi${!units ? '' : units === 1 ? ' mốt' : units === 5 ? ' lăm' : ` ${VI_UNITS[units]}`}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100), rest = n % 100;
    return `${VI_UNITS[hundreds]} trăm${!rest ? '' : rest < 10 ? ` lẻ ${VI_UNITS[rest]}` : ` ${vietnameseNumber(rest)}`}`;
  }
  return String(n);
}

const TEMPERATURE = /(−|-)?(\d+)°([FC])/g;

/** `text` as a speaker should read it in `lang`. The unit is said once, with the first temperature. */
export function spokenAnswer(text: string, lang: QuestionLang | 'en'): string {
  if (lang === 'en') return spokenDegrees(text);
  let first = true;
  const temps = (say: (n: number, unit: string, first: boolean) => string) => (_m: string, minus: string | undefined, n: string, unit: string) => {
    const out = say((minus ? -1 : 1) * Number(n), unit, first);
    first = false;
    return out;
  };

  if (lang === 'vi') {
    return text
      .replace(TEMPERATURE, temps((n, unit, once) => `${vietnameseNumber(n)} độ${once ? ` ${unit}` : ''}`))
      .replace(/(\d+)%/g, (_m, n: string) => `${vietnameseNumber(Number(n))} phần trăm`)
      .replace(/\d+/g, (n) => vietnameseNumber(Number(n)));
  }

  const yue = lang === 'yue';
  const fahrenheit = yue ? '華氏' : '华氏';
  return text
    // A city in English letters ("New York：") is beyond a Chinese voice, and slows it badly: left unsaid.
    .replace(/^[A-Za-z][A-Za-z .'-]*：/, '')
    .replace(TEMPERATURE, temps((n, unit, once) => `${once && unit === 'F' ? fahrenheit : ''}${chineseNumber(n)}度`))
    .replace(/(\d+)%/g, (_m, n: string) => `百分之${chineseNumber(Number(n))}`)
    // 2點 is 兩點 (两点); 8點05分 is 八點零五分.
    .replace(/(\d+)(點|点)/g, (_m, n: string, dian: string) => `${n === '2' ? (yue ? '兩' : '两') : chineseNumber(Number(n))}${dian}`)
    .replace(/(\d+)分/g, (_m, n: string) => `${n.length === 2 && n[0] === '0' ? '零' : ''}${chineseNumber(Number(n))}分`)
    .replace(/\d+/g, (n) => chineseNumber(Number(n)));
}

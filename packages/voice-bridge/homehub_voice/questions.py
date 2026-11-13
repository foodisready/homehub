"""The time, the date and the weather, asked in Vietnamese or Cantonese.

HomeHub answers these in English ("what time is it", "what's the weather"), with
the numbers alongside; the reply is said here in the language that was spoken:
"Bây giờ là ba giờ bốn mươi lăm phút chiều", "而家係下晝三點四十五分".
English questions need nothing from here: HomeHub's English reply is read out.
"""
from __future__ import annotations

from . import cantonese as yue
from . import vietnamese as vi

# What HomeHub is asked for each question.
ENGLISH = {
    'time': 'what time is it',
    'date': "what's the date",
    'today': "what's the weather",
    'tomorrow': "what's the weather tomorrow",
    'rain-today': 'will it rain today',
    'rain-tomorrow': 'will it rain tomorrow',
}


def _weather_kind(rain: bool, weather: bool, tomorrow: bool) -> str | None:
    if rain and not weather:
        return 'rain-tomorrow' if tomorrow else 'rain-today'
    if weather or rain:
        return 'tomorrow' if tomorrow else 'today'
    return None


# ── Vietnamese ──────────────────────────────────────────────────

VI_TIME = ('may gio',)                                           # mấy giờ (rồi)
VI_DATE = ('thu may', 'ngay may', 'ngay bao nhieu', 'mung may')  # thứ mấy, ngày mấy, ngày bao nhiêu
VI_WEATHER = ('thoi tiet', 'nhiet do', 'bao nhieu do', 'may do', 'nong khong', 'lanh khong', 'troi nong', 'troi lanh')


def vi_kind(text: str) -> str | None:
    """Which question a Vietnamese sentence asks, or None. A command ("bật đèn") is never one."""
    if not vi.has_vietnamese(text):
        return None
    ws = vi.words(text)
    if vi.read_verb(ws)[0] in ('on', 'off'):
        return None
    p = f' {vi.plain(text)} '
    has = lambda phrases: any(f' {x} ' in p for x in phrases)  # noqa: E731
    if has(VI_TIME):
        return 'time'
    if has(VI_DATE):
        return 'date'
    # "mưa" (rain) only with its accent: "mua" is "buy".
    return _weather_kind('mưa' in ws, has(VI_WEATHER), ' ngay mai ' in p)


VI_WEEKDAYS = ['Chủ nhật', 'thứ hai', 'thứ ba', 'thứ tư', 'thứ năm', 'thứ sáu', 'thứ bảy']
VI_WEATHER_WORDS = {
    'clear': 'trời quang', 'mostly clear': 'trời khá quang', 'partly cloudy': 'có mây rải rác', 'cloudy': 'nhiều mây',
    'foggy': 'có sương mù', 'drizzly': 'có mưa phùn', 'light rain': 'có mưa nhẹ', 'rain': 'có mưa', 'heavy rain': 'mưa to',
    'freezing rain': 'mưa băng', 'light snow': 'có tuyết nhẹ', 'snow': 'có tuyết', 'thunderstorms': 'có giông',
}


def _vi_num(n: int) -> str:
    return f'âm {vi.say_number(-n)}' if n < 0 else vi.say_number(n)


def _vi_hour(hour: int, minute: int) -> str:
    period = 'sáng' if hour < 11 else 'trưa' if hour < 13 else 'chiều' if hour < 18 else 'tối' if hour < 22 else 'đêm'
    if hour == 0:
        period = 'đêm'
    h = hour % 12 or 12
    return f'{vi.say_number(h)} giờ' + (f' {vi.say_number(minute)} phút' if minute else '') + f' {period}'


def _vi_rain(day: dict, when: str) -> str:
    n = _vi_num(day['rain'])
    if day['rain'] >= 60:
        return f'Có, {when} nhiều khả năng mưa, {n} phần trăm.'
    if day['rain'] >= 30:
        return f'Có thể, {when} khả năng mưa {n} phần trăm.'
    return f'{when.capitalize()} ít khả năng mưa, {n} phần trăm.'


def vi_reply(kind: str, info: dict | None) -> str:
    if not info:
        return vi.NOT_UNDERSTOOD
    if kind == 'time':
        return f'Bây giờ là {_vi_hour(info["hour"], info["minute"])}.'
    if kind == 'date':
        day = info['day']
        return f'Hôm nay là {VI_WEEKDAYS[info["weekday"]]}, ngày {"mùng " if day <= 10 else ""}{vi.say_number(day)} tháng {vi.say_number(info["month"])}.'
    if info.get('error'):
        return ('HomeHub chưa biết nhà bạn ở đâu. Hãy đặt vị trí trong phần Cài đặt.' if info.get('code') == 'NOT_LOCATED'
                else 'Hiện không lấy được thông tin thời tiết.')
    unit = ' F' if info.get('unit') == 'F' else ''
    cond = lambda code: VI_WEATHER_WORDS.get(describe(code), 'thời tiết thay đổi')  # noqa: E731
    if kind == 'rain-today':
        return 'Có, trời đang mưa.' if raining(info['now']['code']) else _vi_rain(info['today'], 'hôm nay')
    if kind == 'rain-tomorrow':
        return _vi_rain(info['tomorrow'], 'ngày mai')
    rain = lambda d: f' Khả năng mưa {_vi_num(d["rain"])} phần trăm.' if d['rain'] >= 30 else ''  # noqa: E731
    if kind == 'tomorrow':
        t = info['tomorrow']
        return f'Ngày mai {cond(t["code"])}, cao nhất {_vi_num(t["high"])}, thấp nhất {_vi_num(t["low"])} độ{unit}.{rain(t)}'
    t, now = info['today'], info['now']
    return (f'Bây giờ trời {_vi_num(now["temperature"])} độ{unit}, {cond(now["code"])}. '
            f'Hôm nay cao nhất {_vi_num(t["high"])}, thấp nhất {_vi_num(t["low"])} độ.{rain(t)}')


# ── Cantonese ───────────────────────────────────────────────────

YUE_TIME = [('gei', 'dim')]                                                    # 幾點
YUE_DATE = [('gei', 'hou'), ('sing', 'kei', 'gei'), ('lai', 'baai', 'gei')]     # 幾號, 星期幾, 禮拜幾
YUE_WEATHER = [('tin', 'hei'), ('gei', 'dou'), ('wan', 'dou'), ('jit', 'm', 'jit'), ('dung', 'm', 'dung')]  # 天氣 幾度 溫度 熱唔熱 凍唔凍
YUE_RAIN = [('lok', 'jyu')]                                                    # 落雨
YUE_TOMORROW = [('ting', 'jat'), ('ming', 'tin'), ('ting', 'ji'), ('ting', 'dit')]   # 聽日, 明天


def _has(s: tuple[str, ...], options: list[tuple[str, ...]]) -> bool:
    return any(s[i:i + len(o)] == o for o in options for i in range(len(s) - len(o) + 1))


def yue_kind(text: str) -> str | None:
    """Which question a Cantonese sentence asks, by its sound, or None. A command is never one."""
    if not text or not yue.has_chinese(text):
        return None
    s = yue.syllables(text)
    if yue.read_verb(s)[0] is not None:
        return None
    if _has(s, YUE_TIME):
        return 'time'
    if _has(s, YUE_DATE):
        return 'date'
    return _weather_kind(_has(s, YUE_RAIN), _has(s, YUE_WEATHER), _has(s, YUE_TOMORROW))


YUE_DIGITS = '零一二三四五六七八九'
YUE_WEEKDAYS = '日一二三四五六'
YUE_WEATHER_WORDS = {
    'clear': '天晴', 'mostly clear': '大致天晴', 'partly cloudy': '間中有雲', 'cloudy': '多雲', 'foggy': '有霧',
    'drizzly': '有毛毛雨', 'light rain': '有微雨', 'rain': '有雨', 'heavy rain': '有大雨', 'freezing rain': '有凍雨',
    'light snow': '有小雪', 'snow': '落雪', 'thunderstorms': '有雷暴',
}


def yue_number(n: int) -> str:
    """A number as written to be read in Cantonese: 二, 十二, 四十五, 一百零五, 零下三."""
    if n < 0:
        return '零下' + yue_number(-n)
    if n < 10:
        return YUE_DIGITS[n]
    if n < 100:
        tens, units = divmod(n, 10)
        return ('' if tens == 1 else YUE_DIGITS[tens]) + '十' + (YUE_DIGITS[units] if units else '')
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        tail = '' if not rest else ('零' + YUE_DIGITS[rest] if rest < 10 else ('一' if rest < 20 else '') + yue_number(rest))
        return YUE_DIGITS[hundreds] + '百' + tail
    return str(n)


def _yue_hour(hour: int, minute: int) -> str:
    period = '凌晨' if hour < 6 else '朝早' if hour < 12 else '中午' if hour < 13 else '下晝' if hour < 18 else '夜晚'
    h = hour % 12 or 12
    hs = '兩' if h == 2 else yue_number(h)
    if not minute:
        return f'{period}{hs}點正'
    if minute == 30:
        return f'{period}{hs}點半'
    return f'{period}{hs}點{"零" if minute < 10 else ""}{yue_number(minute)}分'


def _yue_rain(day: dict, when: str) -> str:
    n = yue_number(day['rain'])
    if day['rain'] >= 60:
        return f'會，{when}好大機會落雨，機會百分之{n}。'
    if day['rain'] >= 30:
        return f'可能會，{when}落雨機會百分之{n}。'
    return f'{when}唔多會落雨，機會百分之{n}。'


def yue_reply(kind: str, info: dict | None) -> str:
    if not info:
        return yue.NOT_UNDERSTOOD
    if kind == 'time':
        return f'而家係{_yue_hour(info["hour"], info["minute"])}。'
    if kind == 'date':
        return f'今日係{yue_number(info["month"])}月{yue_number(info["day"])}號，星期{YUE_WEEKDAYS[info["weekday"]]}。'
    if info.get('error'):
        return ('HomeHub未知你屋企喺邊，請喺設定度揀位置。' if info.get('code') == 'NOT_LOCATED'
                else '而家攞唔到天氣資料。')
    unit = '華氏' if info.get('unit') == 'F' else ''
    cond = lambda code: YUE_WEATHER_WORDS.get(describe(code), '天氣多變')  # noqa: E731
    if kind == 'rain-today':
        return '係，而家落緊雨。' if raining(info['now']['code']) else _yue_rain(info['today'], '今日')
    if kind == 'rain-tomorrow':
        return _yue_rain(info['tomorrow'], '聽日')
    rain = lambda d: f'落雨機會百分之{yue_number(d["rain"])}。' if d['rain'] >= 30 else ''  # noqa: E731
    if kind == 'tomorrow':
        t = info['tomorrow']
        return f'聽日{cond(t["code"])}，最高{unit}{yue_number(t["high"])}度，最低{yue_number(t["low"])}度。{rain(t)}'
    t, now = info['today'], info['now']
    return (f'而家{unit}{yue_number(now["temperature"])}度，{cond(now["code"])}。'
            f'今日最高{yue_number(t["high"])}度，最低{yue_number(t["low"])}度。{rain(t)}')


# ── Weather codes (WMO), as HomeHub's home/weather.ts reads them ────

def describe(code: int) -> str:
    if code == 0:
        return 'clear'
    if code == 1:
        return 'mostly clear'
    if code == 2:
        return 'partly cloudy'
    if code == 3:
        return 'cloudy'
    if code in (45, 48):
        return 'foggy'
    if 51 <= code <= 57:
        return 'drizzly'
    if code in (61, 80):
        return 'light rain'
    if code in (63, 81):
        return 'rain'
    if code in (65, 82):
        return 'heavy rain'
    if code in (66, 67):
        return 'freezing rain'
    if code in (71, 85):
        return 'light snow'
    if code in (73, 75, 77, 86):
        return 'snow'
    if code >= 95:
        return 'thunderstorms'
    return 'mixed'


def raining(code: int) -> bool:
    return 51 <= code <= 67 or 80 <= code <= 82 or code >= 95

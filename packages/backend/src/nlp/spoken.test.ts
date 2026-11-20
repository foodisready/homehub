import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chineseNumber, spokenAnswer, vietnameseNumber } from './spoken';

describe('spokenAnswer', () => {
  it('reads Cantonese weather with 華氏 once and numbers in words', () => {
    assert.equal(spokenAnswer('紐約：而家43°F，天晴。今日最高69°F，最低41°F。落雨機會30%。', 'yue'),
      '紐約：而家華氏四十三度，天晴。今日最高六十九度，最低四十一度。落雨機會百分之三十。');
    assert.equal(spokenAnswer('紐約：聽日最低40°F，最高64°F。', 'yue'), '紐約：聽日最低華氏四十度，最高六十四度。');
  });

  it('says Celsius as plain 度 and below zero as 零下', () => {
    assert.equal(spokenAnswer('而家−2°C，落雪。', 'yue'), '而家零下二度，落雪。');
    assert.equal(spokenAnswer('北京：明天最高5°C，最低-3°C。', 'zh'), '北京：明天最高五度，最低零下三度。');
  });

  it('reads Mandarin with 华氏 and 两点', () => {
    assert.equal(spokenAnswer('现在体感28°F，今天最高35°F。', 'zh'), '现在体感华氏二十八度，今天最高三十五度。');
    assert.equal(spokenAnswer('现在是下午2点05分。', 'zh'), '现在是下午两点零五分。');
  });

  it('reads Cantonese clock and date numbers in words', () => {
    assert.equal(spokenAnswer('而家係夜晚8點15分。', 'yue'), '而家係夜晚八點十五分。');
    assert.equal(spokenAnswer('而家係下晝2點正。', 'yue'), '而家係下晝兩點正。');
    assert.equal(spokenAnswer('今日係11月20號，星期五。', 'yue'), '今日係十一月二十號，星期五。');
  });

  it('reads Vietnamese with độ F once and numbers in words', () => {
    assert.equal(spokenAnswer('Ngày mai thấp nhất 50°F, cao nhất 65°F. Khả năng mưa 45%.', 'vi'),
      'Ngày mai thấp nhất năm mươi độ F, cao nhất sáu mươi lăm độ. Khả năng mưa bốn mươi lăm phần trăm.');
    assert.equal(spokenAnswer('Bây giờ trời −1°C.', 'vi'), 'Bây giờ trời âm một độ C.');
  });

  it('leaves a city in English letters unsaid in Chinese', () => {
    assert.equal(spokenAnswer('New York：聽日應該唔會落雨。', 'yue'), '聽日應該唔會落雨。');
    assert.equal(spokenAnswer('紐約：聽日應該唔會落雨。', 'yue'), '紐約：聽日應該唔會落雨。');
  });

  it('keeps English as spoken degrees', () => {
    assert.equal(spokenAnswer("It's 40°F.", 'en'), "It's 40 degrees.");
  });

  it('writes numbers out', () => {
    assert.deepEqual([0, 10, 12, 20, 45, 100, 105, 110].map(chineseNumber), ['零', '十', '十二', '二十', '四十五', '一百', '一百零五', '一百一十']);
    assert.deepEqual([10, 15, 21, 25, 41, 105].map(vietnameseNumber), ['mười', 'mười lăm', 'hai mươi mốt', 'hai mươi lăm', 'bốn mươi mốt', 'một trăm lẻ năm']);
  });
});

'use strict';
// 冒烟第 6 步辅助：对指定文件做"无改动保存"，断言 written=false（不写盘路径）。
const fs = require('node:fs');
const store = require('../src/main/store.cjs');

const file = process.argv[2];
const text = fs.readFileSync(file, 'utf8');
const result = store.saveKind({ kind: 'units', data: JSON.parse(text), baseHash: store.sha256(text) });
console.log(JSON.stringify(result));

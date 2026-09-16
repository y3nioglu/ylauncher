import { strict as assert } from 'node:assert'
import { analyzeCrashLog } from '../src/main/crashAnalyzer'

// Fabric eksik bagimlilik (VeinMiner/fabric-language-kotlin senaryosi)
const fabricLog = `Incompatible mods found!
net.fabricmc.loader.impl.FormattedException: Some of your mods are incompatible with the game or each other!
	 - Mod 'Veinminer' (veinminer) 2.11.2 requires any version of fabric-language-kotlin, which is missing!`

const d1 = analyzeCrashLog(fabricLog)
assert.ok(d1, 'Fabric eksik bagimlilik yakalanmali')
assert.match(d1.title, /Eksik mod bagimliligi/i)
assert.ok(d1.fix.length > 10)

// Java surumu
const d2 = analyzeCrashLog('java.lang.UnsupportedClassVersionError: class file version 65.0')
assert.ok(d2 && /Java/.test(d2.title), 'Java surumu yakalanmali')

// OutOfMemory
const d3 = analyzeCrashLog('java.lang.OutOfMemoryError: Java heap space')
assert.ok(d3 && /bellek/i.test(d3.title), 'OOM yakalanmali')

// Offline auth uyarisi (severity: warning)
const d4 = analyzeCrashLog('Failed to fetch user properties\nInvalidCredentialsException: Status: 401')
assert.ok(d4 && d4.severity === 'warning', 'Offline auth uyari olarak siniflandirilmali')

// Eslesme yok
assert.equal(analyzeCrashLog('sadece normal bir log satiri'), null)
assert.equal(analyzeCrashLog(''), null)

console.log('crashAnalyzer.ts testleri OK')

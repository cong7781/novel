/**
 * Synthetic long-form fixture generator.
 *
 * The pipeline needs a 100k–600k character narrative to be measured on, and the 8.8k fixture is not
 * one. Rather than repeating the same paragraphs (which would make extraction look artificially
 * consistent) this composes scenes from independent slot pools with a seeded RNG, so:
 *
 *   - no two scenes are the same paragraph, and the scene order is shuffled;
 *   - a fixed social graph decides who appears together, so relationships are not random noise;
 *   - every declared relation is stated explicitly somewhere, which gives the run a ground truth to
 *     measure recall against (see `<out>.manifest.json`);
 *   - a character is sometimes called by an alias inside the same scene, which exercises the global
 *     entity-resolution stage;
 *   - the whole thing is deterministic: same seed + same target = same file.
 *
 *   node scripts/make-longtext.mjs --target 100000 --out out/texts/novel-100k.txt --seed 7
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = parseArgs(process.argv.slice(2))

const target = Number(args.target ?? 100000)
const seed = Number(args.seed ?? 7)
const outPath = resolve(ROOT, args.out ?? `out/texts/novel-${Math.round(target / 1000)}k.txt`)
const manifestPath = args.manifest ? resolve(ROOT, args.manifest) : outPath.replace(/\.txt$/, '.manifest.json')

// ── cast: the same universe as the 8.8k fixture, extended ───────────────────────────────────
const CAST = [
  { name: '苏晚', aliases: ['晚娘', '三姑娘', '晚姑娘'], role: '药铺女儿' },
  { name: '沈砚', aliases: ['砚哥儿', '小先生', '沈家小先生'], role: '药铺少东家' },
  { name: '沈鹤年', aliases: ['老沈', '沈掌柜', '爹'], role: '药铺东家' },
  { name: '柳氏', aliases: ['柳娘子', '姨娘'], role: '沈鹤年续弦' },
  { name: '周砚秋', aliases: ['周当家', '周老板'], role: '漕运帮主' },
  { name: '白露', aliases: ['露姑娘'], role: '船娘' },
  { name: '顾青崖', aliases: ['顾先生', '游方郎中'], role: '游方郎中' },
  { name: '阿竹', aliases: ['竹儿'], role: '药铺伙计' },
  { name: '钱九', aliases: ['九爷'], role: '船工头目' },
  { name: '崔嬷嬷', aliases: ['嬷嬷'], role: '沈府管家' },
  { name: '陆知州', aliases: ['知州大人', '陆大人'], role: '州府官员' },
  { name: '阿棠', aliases: ['棠儿'], role: '周家侍女' },
]

/** Declared relationships: the generator states each one explicitly so recall can be measured. */
const RELATIONS = [
  { a: '沈鹤年', b: '沈砚', kind: '亲子', templates: ['沈砚是沈鹤年的独子，铺子里的人都喊他小先生。', '沈鹤年看着沈砚的背影，想起这孩子小时候在药碾子边上睡着的样子。'] },
  { a: '沈鹤年', b: '苏晚', kind: '亲子', templates: ['苏晚是沈鹤年收养的女儿，户口簿上写着沈姓，铺子里的人叫她三姑娘。', '沈鹤年把苏晚当亲女儿养大，却从不许她进后堂的账房。'] },
  { a: '柳氏', b: '苏晚', kind: '亲戚', templates: ['柳氏是苏晚的姨母，也是沈鹤年续弦的夫人。', '苏晚叫柳氏一声姨母，这声称呼比叫她母亲还顺口。'] },
  { a: '苏晚', b: '沈砚', kind: '情人', templates: ['苏晚和沈砚从小一起在这条巷子里长大，谁都没把那句话说出口。', '沈砚把手炉塞进苏晚手里，说，别冻着，转身就走，耳根是红的。'] },
  { a: '顾青崖', b: '沈砚', kind: '师徒', templates: ['顾青崖收过沈砚做徒弟，教他辨药，也教他写字。', '沈砚跪下来给顾青崖磕头，叫了一声师父。'] },
  { a: '阿竹', b: '沈砚', kind: '主仆', templates: ['阿竹是铺子里的伙计，跟着沈砚跑前跑后。', '阿竹应了一声，说，少爷，我跟着您去。'] },
  { a: '周砚秋', b: '沈砚', kind: '敌对', templates: ['周砚秋要那张方子，沈砚不肯给，两个人在江边上顶了三年。', '周砚秋说，方子在你脑子里，那我就把你的脑子带到江上去。'] },
  { a: '周砚秋', b: '钱九', kind: '主仆', templates: ['钱九替周砚秋管着十二条船，从不多问一句。', '钱九说，周当家，这趟货我亲自押。'] },
  { a: '白露', b: '苏晚', kind: '朋友', templates: ['白露一上岸就来找苏晚，两个人蹲在药铺后门分一包糖。', '白露说，苏晚，你要是过不下去，就上我的船。'] },
  { a: '白露', b: '钱九', kind: '亲戚', templates: ['白露是钱九的妹妹，一个在岸上，一个在船上。', '钱九管不了白露，只在她说要走的时候把船钱压在桌上。'] },
  { a: '崔嬷嬷', b: '柳氏', kind: '主仆', templates: ['崔嬷嬷在沈府当了三十年管家，只认柳氏这一个太太。', '崔嬷嬷说，太太放心，后堂的门我锁着。'] },
  { a: '陆知州', b: '周砚秋', kind: '上下级', templates: ['陆知州收过周砚秋的礼，也替他压过两回案子。', '陆知州在花厅里见周砚秋，话说得客气，茶却是凉的。'] },
  { a: '阿棠', b: '白露', kind: '朋友', templates: ['阿棠和白露同乡，都是江南水边长大的。', '阿棠替白露藏过一只匣子，没问里面是什么。'] },
  { a: '顾青崖', b: '沈鹤年', kind: '朋友', templates: ['顾青崖和沈鹤年是三十年的旧识，一见面就吵药方。', '沈鹤年说，青崖，你这一手脉，还是当年那样准。'] },
  { a: '钱九', b: '沈砚', kind: '同僚', templates: ['钱九替沈砚运过三回药，账算得清清楚楚。', '钱九说，沈少爷，水路我熟，您只管把药装船。'] },
]

const OPENERS = [
  '天还没亮，巷子里的青石板上积着一层薄水。',
  '雨落在瓦上，落了一整夜，到辰时才停。',
  '江面上起了雾，船灯只剩一团模糊的黄。',
  '药铺刚卸下门板，街上已经有了人声。',
  '后堂的灯点到三更，灯芯爆了一下。',
  '那天风大，晾在院子里的药材被吹得满地都是。',
  '码头上的号子响了三遍，最后一趟货才起岸。',
  '知州衙门的鼓响过五下，街口的差役换了班。',
  '雪是半夜下的，到早上已经盖住了门槛。',
  '入秋以后，沈府的院子里总是潮的。',
  '端午前三天，街上到处是艾草的味道。',
  '那一年漕运查得紧，江卡每隔十里就有一道。',
  '药铺的柜台上摆着一排白瓷瓶，标签都换过一遍。',
  '院子里的老槐树落了一地叶子，没人扫。',
  '天热得厉害，连狗都躲在檐下不肯动。',
]

const ACTIONS = [
  '苏晚把药碾子擦干净，药末归到一处。',
  '沈砚把账本合上，手指在封面上压了一压。',
  '阿竹抱着一捆柴从后门进来，袖口全湿了。',
  '崔嬷嬷把门帘放下，回头看了一眼院子。',
  '柳氏把汤药端到廊下，热气在雨里散得很快。',
  '顾青崖把脉枕收进箱子，又取出一支银针。',
  '钱九蹲在岸边抽烟，烟灰掉在水里就没影了。',
  '白露把绳结解开，船身轻轻撞了一下石阶。',
  '周砚秋把茶盏推开，水面晃出一圈纹。',
  '陆知州把文书翻到第二页，没有抬头。',
  '阿棠把灯挑亮一些，火苗歪了一下。',
  '苏晚数了一遍药包，最后又多数了一遍。',
  '沈鹤年咳嗽了几声，手撑在桌沿上。',
  '沈砚把方子折好，塞进贴身的衣襟里。',
  '顾青崖走到门口又停下，回头说了一句什么。',
]

const DIALOGUE = [
  ['这帖药要趁热喝，凉了伤胃', '我喝了'],
  ['方子在我这儿，你拿去也没用', '那我把你带走'],
  ['铺子里的账，你看过了', '看过了，差三两七钱'],
  ['明天一早的船，你上不上', '上'],
  ['你娘当年也是这么说的', '别提我娘'],
  ['这雨再下三天，江卡就封了', '那就今天走'],
  ['我不走', '你不走，我留在这也没意思'],
  ['后堂的门是谁开的', '我没开'],
  ['你把手伸出来，我看看脉', '你只管看'],
  ['这味药少一钱，整帖就废了', '那就重抓'],
  ['知州那边已经有人递了话', '递话的人是谁'],
  ['你叫我一声师父，我就得管你', '师父'],
  ['这件事到此为止', '到不了'],
  ['灯留着，别灭', '知道'],
  ['你瘦了', '路上没吃东西'],
  ['钱的事以后再说，先把人救回来', '人已经在床上了'],
]

const CLOSERS = [
  '话说到这儿，屋里就静下来，只剩雨声。',
  '两个人谁都没再开口，各自坐了一会儿。',
  '灯灭之前，账本还摊在桌上。',
  '门是从外面关上的，声音很轻。',
  '巷子尽头有人唱了一句什么，很快就断了。',
  '江上的雾散了，露出一线白。',
  '第二天这铺子照常开门，好像什么都没发生。',
  '那只匣子最后被塞进了米缸底下。',
  '三天以后，江卡果然封了。',
  '这件小事，后来谁也没再提。',
  '院子里的水还没干，脚印先干了。',
  '等到更夫敲过四更，人才散。',
  '雪停的时候，天已经亮了。',
  '药铺的门板一块一块上回去，声音很钝。',
  '那盏灯到底还是灭了。',
]

const PROPS = [
  '桌角压着一张旧方子，纸都黄了。',
  '药柜最上一层落着灰，没人动过。',
  '柜台上放着一只白瓷碗，碗沿有个缺口。',
  '角落里堆着三只空箱子，标签被水浸花了。',
  '墙上挂着一杆秤，秤砣是铜的。',
  '窗台上晾着几片切好的药材，边缘卷起来。',
  '灶上温着一壶水，壶盖在轻轻响。',
  '靠墙的凳子上搁着一件湿衣裳。',
  '账本最后一页写着两个字，笔画很重。',
  '檐下挂着一串风干的艾草。',
]

const WEATHER = [
  '风从江面上来，带着一点潮气。',
  '天色阴沉，看不出时辰。',
  '日头偏西，屋里的影子拉得很长。',
  '外面起了一阵风，把门吹得响了一下。',
  '雨又下起来，比刚才密。',
  '院子里很静，只有水滴下来。',
]

const CHAPTER_TITLES = ['江上风波', '药香夜话', '旧账难清', '一纸方子', '漕运暗流', '灯下故人', '满城风雨', '空匣']

// ── builder ────────────────────────────────────────────────────────────────────────────────
const rng = mulberry32(seed)
const pick = (list) => list[Math.floor(rng() * list.length)]
const chance = (p) => rng() < p

const castByName = new Map(CAST.map((character) => [character.name, character]))
const usedScenes = new Set()
const pairCounts = new Map()
const relationHits = new Map()
let relationDeclarations = 0
let aliasUses = 0

function nameOf(character) {
  // Occasionally use an alias in the narration: this is what makes entity resolution a real problem
  // rather than a solved one, and it is how a novel actually reads.
  if (character.aliases.length > 0 && chance(0.32)) {
    aliasUses += 1
    return pick(character.aliases)
  }
  return character.name
}

function buildScene() {
  const relation = chance(0.55) ? pick(RELATIONS) : null
  const participants = []
  if (relation) {
    participants.push(castByName.get(relation.a), castByName.get(relation.b))
  } else {
    const first = pick(CAST)
    const second = pick(CAST.filter((character) => character.name !== first.name))
    participants.push(first, second)
  }
  if (chance(0.4)) {
    const third = pick(CAST.filter((character) => !participants.some((person) => person.name === character.name)))
    participants.push(third)
  }

  const key = participants.map((person) => person.name).join('+')
  const lines = []

  lines.push(`${pick(OPENERS)}${chance(0.6) ? pick(WEATHER) : ''}`)

  const [a, b] = participants
  if (relation && chance(0.75)) {
    relationDeclarations += 1
    lines.push(pick(relation.templates))
    relationHits.set(`${relation.a}|${relation.b}`, (relationHits.get(`${relation.a}|${relation.b}`) ?? 0) + 1)
  }

  // Alias declaration, of the kind the alias miner looks for.
  if (chance(0.22)) {
    const speaker = pick(participants)
    if (speaker.aliases.length > 0) {
      lines.push(`${speaker.name}，人称${pick(speaker.aliases)}，这条巷子里的人都这么叫。`)
    }
  }

  lines.push(pick(ACTIONS))
  if (chance(0.7)) lines.push(pick(PROPS))

  const [lineA, lineB] = pick(DIALOGUE)
  lines.push(`${nameOf(a)}说，${lineA}。`)
  lines.push(`${nameOf(b)}说，${lineB}。`)
  if (participants.length > 2) {
    const third = participants[2]
    lines.push(`${nameOf(third)}在旁边听着，没有插话，手指在膝上按了一下。`)
  }

  if (chance(0.45)) lines.push(pick(ACTIONS))
  lines.push(pick(CLOSERS))

  // A character pair is "co-occurring" whenever it shares a scene; that is the ground truth for
  // retrieval, not for the graph (the graph still has to verify a quote).
  for (let i = 0; i < participants.length; i += 1) {
    for (let j = i + 1; j < participants.length; j += 1) {
      const pair = [participants[i].name, participants[j].name].sort().join('|')
      pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1)
    }
  }

  const body = lines.join('')
  if (usedScenes.has(body)) return null
  usedScenes.add(body)
  return { text: body, participants: participants.map((person) => person.name), relation: relation?.kind ?? null, key }
}

const sceneTexts = []
let totalChars = 0
let sceneCount = 0
let guard = 0
while (totalChars < target && guard < 400000) {
  guard += 1
  const scene = buildScene()
  if (!scene) continue
  sceneCount += 1
  sceneTexts.push(scene.text)
  totalChars += scene.text.length + 2
}

// Shuffle the scenes inside each chapter so the file is not "template 1, template 2, …" in
// generation order: repeated structure is exactly what makes an extractor look better than it is.
const CHAPTER_SIZE = 9
const chapters = []
for (let i = 0; i < sceneTexts.length; i += CHAPTER_SIZE) {
  chapters.push(shuffle(sceneTexts.slice(i, i + CHAPTER_SIZE)))
}

const blocks = []
chapters.forEach((chapterScenes, index) => {
  blocks.push(`第${index + 1}回　${pick(CHAPTER_TITLES)}`)
  blocks.push(...chapterScenes)
})
let text = `${blocks.join('\n\n')}\n`

// The pipeline's hard ceiling is 600,000 characters, and a scene overshoots the target by up to one
// paragraph. Trim at a paragraph boundary so a "600k" fixture is legal input rather than a 605k one.
if (text.length > target) {
  const cut = text.lastIndexOf('\n\n', target)
  text = cut > 0 ? `${text.slice(0, cut)}\n` : text.slice(0, target)
}

const relationTruth = RELATIONS.map((relation) => ({
  a: relation.a,
  b: relation.b,
  kind: relation.kind,
  declared: relationHits.get(`${relation.a}|${relation.b}`) ?? 0,
}))

const manifest = {
  v: 1,
  seed,
  target,
  chars: text.length,
  scenes: sceneCount,
  chapters: chapters.length,
  cast: CAST,
  relations: relationTruth,
  pairs: [...pairCounts.entries()]
    .map(([pair, count]) => ({ pair, count }))
    .sort((a, b) => b.count - a.count),
  aliasUses,
  relationDeclarations,
}

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, text, 'utf8')
await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')

const topPairs = manifest.pairs.slice(0, 8).map((entry) => `${entry.pair}×${entry.count}`).join('  ')
console.log(`wrote ${outPath}`)
console.log(`  ${text.length.toLocaleString('en-US')} 字 / ${sceneCount} 场 / ${chapters.length} 回 / 别名 ${aliasUses} 处 / 明写关系 ${relationDeclarations} 处`)
console.log(`  manifest: ${manifestPath}`)
console.log(`  同现最多的人物对: ${topPairs}`)

/** Fisher-Yates with the seeded RNG, so a chapter is shuffled deterministically. */
function shuffle(list) {
  const copy = [...list]
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    const swap = copy[i]
    copy[i] = copy[j]
    copy[j] = swap
  }
  return copy
}

function mulberry32(start) {
  let state = start >>> 0
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function parseArgs(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) parsed[key] = true
    else {
      parsed[key] = next
      i += 1
    }
  }
  return parsed
}

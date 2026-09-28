const $ = id => document.getElementById(id);
let quiz = [], index = 0, correct = 0, answered = false, solveMode = 'practice';
const state = JSON.parse(localStorage.getItem('network-exam-v2') || '{"solved":0,"wrong":[]}');
state.stats ||= {};

function updateHome() {
  $('total-count').textContent = questions.length;
  $('solved-count').textContent = state.solved;
  $('wrong-hint').textContent = state.wrong.length ? `현재 오답 ${state.wrong.length}개` : '아직 저장된 오답이 없습니다.';
  $('wrong-button').textContent = state.wrong.length ? `오답노트 보기 (${state.wrong.length})` : '오답노트 보기';
}
function save() { localStorage.setItem('network-exam-v2', JSON.stringify(state)); updateHome(); }
function show(section) { ['start', 'quiz', 'result', 'browse', 'wrong'].forEach(id => $(id).classList.toggle('hidden', id !== section)); }
function start() {
  solveMode = document.querySelector('input[name="solve-mode"]:checked').value;
  const selected = [...document.querySelectorAll('#subjects input:checked')].map(input => input.value);
  if (solveMode === 'exam' && $('question-count').value === 'all' && selected.length === 4) {
    const examPlan = window.examCatalog[$('exam-select').value].examPlan;
    const pick = (category, count) => {
      const weight = i => { const stat = state.stats[i]; return stat ? 1 + (1 - stat.correct / stat.attempts) * 2 : 1; };
      const pool = questions.map((item, i) => ({item, i})).filter(({item}) => item.category === category);
      const unseen = pool.filter(({i}) => !state.stats[i]).sort(() => Math.random() - .5).slice(0, Math.ceil(count * .3));
      const selected = new Set(unseen.map(({i}) => i));
      const rest = pool.filter(({i}) => !selected.has(i)).sort(({i:a}, {i:b}) => Math.random() / weight(a) - Math.random() / weight(b));
      return [...unseen, ...rest.slice(0, count - unseen.length)].map(({item}) => item);
    };
    quiz = Object.entries(examPlan).flatMap(([category, count]) => pick(category, count));
    quiz.sort(() => Math.random() - .5);
  } else {
    quiz = questions.filter(item => selected.includes(item.category));
  }
  const count = $('question-count').value;
  quiz.sort(() => Math.random() - .5); if (count !== 'all') quiz = quiz.slice(0, Number(count));
  index = 0; correct = 0; show('quiz'); render();
}
function render() {
  const item = quiz[index]; answered = false;
  $('progress').textContent = `${index + 1} / ${quiz.length}`;
  $('progress-fill').style.width = `${(index / quiz.length) * 100}%`;
  $('category').textContent = item.category; $('number').textContent = `문제 ${index + 1}`;
  $('question').textContent = item.question; $('explanation').className = 'explanation hidden'; $('prev-button').className = index ? 'secondary' : 'secondary hidden'; $('next-button').className = 'primary hidden';
  $('choices').innerHTML = item.choices.map((choice, i) => `<button class="choice" data-index="${i}">${choice}</button>`).join('');
}
function answer(selected) {
  if (answered) return; answered = true;
  const item = quiz[index], buttons = [...document.querySelectorAll('.choice')];
  buttons.forEach((button, i) => { button.disabled = true; if (solveMode === 'practice') { if (i === item.answer) button.classList.add('correct'); if (i === selected && i !== item.answer) button.classList.add('wrong'); } });
  const original = questions.indexOf(item), stat = state.stats[original] || {attempts:0, correct:0};
  stat.attempts++; if (selected === item.answer) { correct++; stat.correct++; } else if (!state.wrong.includes(original)) state.wrong.push(original);
  state.stats[original] = stat; save();
  if (solveMode === 'practice') { $('explanation').textContent = item.explanation; $('explanation').className = 'explanation'; }
  $('next-button').className = 'primary';
}
function finish() {
  state.solved++; save(); $('score').textContent = Math.round(correct / quiz.length * 100); $('result-summary').textContent = `${quiz.length}문제 중 ${correct}문제를 맞혔습니다.`; show('result');
}
$('start-button').onclick = start; $('quit-button').onclick = () => { updateHome(); show('start'); }; $('home-button').onclick = () => { updateHome(); show('start'); }; $('retry-button').onclick = start;
$('choices').onclick = event => { const button = event.target.closest('.choice'); if (button) answer(Number(button.dataset.index)); };
$('next-button').onclick = () => index + 1 < quiz.length ? (index++, render()) : finish();
$('prev-button').onclick = () => { if (index) { index--; render(); } };
function setupSubjects() {
  const categories = [...new Set(questions.map(item => item.category))];
  $('subjects').innerHTML = categories.map(category => `<label><input type="checkbox" value="${category}" checked><span>${category}<small>${questions.filter(item => item.category === category).length}문제</small></span></label>`).join('');
  $('question-bank').innerHTML = categories.map(category => `<div class="bank-group"><h3>${category}</h3>${questions.filter(item => item.category === category).map((item, i) => `<details><summary>${i + 1}. ${item.question}</summary><p>정답: ${item.choices[item.answer]}<br>${item.explanation}</p></details>`).join('')}</div>`).join('');
}
$('browse-button').onclick = () => show('browse'); $('browse-home').onclick = () => show('start');
$('wrong-button').onclick = () => { $('wrong-bank').innerHTML = state.wrong.length ? state.wrong.map(i => { const item = questions[i]; return `<details><summary>${item.category} · ${item.question}</summary><p>정답: ${item.choices[item.answer]}<br>${item.explanation}</p></details>`; }).join('') : '<p class="hint">아직 틀린 문제가 없습니다.</p>'; show('wrong'); };
$('wrong-home').onclick = () => show('start');
setupSubjects();
updateHome();
$('theme-button').onclick = () => { const dark = document.body.dataset.theme !== 'dark'; document.body.dataset.theme = dark ? 'dark' : 'light'; localStorage.setItem('network-theme', document.body.dataset.theme); $('theme-button').textContent = dark ? '라이트모드' : '다크모드'; };
if (localStorage.getItem('network-theme') === 'dark') $('theme-button').click();

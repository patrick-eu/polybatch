// content.js — Task 3 骨架版（Task 4 会覆盖为完整版）
(function () {
  const slug = location.pathname.split('/')[2]; // /event/<slug>
  if (!slug) return;
  const panel = document.createElement('div');
  panel.id = 'polybatch-panel';
  panel.innerHTML = '<h3>PolyBatch</h3><div>面板已注入（骨架）</div>';
  document.body.appendChild(panel);
})();

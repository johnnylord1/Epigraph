/**
 * Nocturne Search — expand/dim behavior
 * Include on any page that has `.n-search` and `.n-search-dim`.
 */
(function () {
  const search = document.querySelector('.n-search');
  const dim = document.querySelector('.n-search-dim');
  const input = search?.querySelector('.n-search__input');
  if (!search || !dim || !input) return;

  function expand() {
    search.classList.add('is-expanded');
    dim.classList.add('is-active');
  }

  function collapse() {
    if (document.activeElement === input) input.blur();
    search.classList.remove('is-expanded');
    dim.classList.remove('is-active');
  }

  input.addEventListener('focus', expand);
  dim.addEventListener('click', collapse);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && search.classList.contains('is-expanded')) {
      collapse();
    }
  });
})();

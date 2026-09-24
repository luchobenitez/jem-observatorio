// Menú de navegación.
//
// El botón hamburguesa existía en las seis páginas desde la publicación
// inicial y **no hacía nada**: ningún archivo escuchaba su pulsación. Por
// debajo de 900 px el CSS oculta `.nav-links` y sólo las muestra con la clase
// `.open`, que nadie añadía. El resultado es que el sitio era imposible de
// navegar desde un teléfono: se veía la portada y no había forma de llegar a
// ninguna otra página.
//
// Se descubrió al añadir un séptimo elemento al menú. Añadir una entrada a un
// menú que no abre habría sido trabajo perdido.
(() => {
  const boton = document.querySelector('.nav-toggle');
  const enlaces = document.querySelector('.nav-links');
  if (!boton || !enlaces) return;

  function abrir(estado) {
    enlaces.classList.toggle('open', estado);
    boton.setAttribute('aria-expanded', String(estado));
    boton.textContent = estado ? '✕' : '☰';
  }

  boton.addEventListener('click', () => abrir(!enlaces.classList.contains('open')));

  // Al elegir un destino el menú se cierra solo: en un teléfono, quedarse
  // abierto tapa justamente la página a la que se acaba de llegar.
  enlaces.addEventListener('click', (e) => {
    if (e.target.closest('a')) abrir(false);
  });

  // Escape cierra, como cualquier menú desplegable.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && enlaces.classList.contains('open')) {
      abrir(false);
      boton.focus();
    }
  });

  // Al volver a pantalla ancha, el menú deja de estar desplegado: si no, la
  // clase se queda puesta y el CSS de escritorio la ignora, de modo que el
  // botón quedaría con el aspa puesta sin razón.
  window.matchMedia('(min-width: 901px)').addEventListener('change', (m) => {
    if (m.matches) abrir(false);
  });
})();

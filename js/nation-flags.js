/* =========================================================
   NATION FLAGS: inline SVG so they stay crisp at any size. The Union Flag,
   the tricolour, and for Prussia its colours (white over black) with the Iron
   Cross of 1813 at the centre. A leaf module: the menus and the online lobbies
   both draw them.
========================================================= */
export const NATION_FLAG = {
  britain: '<svg viewBox="0 0 60 30" preserveAspectRatio="none" aria-hidden="true"><clipPath id="ujc"><path d="M0,0 v30 h60 v-30 z"/></clipPath><clipPath id="ujt"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><g clip-path="url(#ujc)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#ujt)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>',
  france: '<svg viewBox="0 0 3 2" preserveAspectRatio="none" aria-hidden="true"><rect width="1" height="2" x="0" fill="#002395"/><rect width="1" height="2" x="1" fill="#fff"/><rect width="1" height="2" x="2" fill="#ED2939"/></svg>',
  prussia: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="20" fill="#f2f2ee"/><rect width="60" height="20" y="20" fill="#151515"/><g transform="translate(30 20)"><path d="M-3,-3 L-5,-11 L5,-11 L3,-3 L11,-5 L11,5 L3,3 L5,11 L-5,11 L-3,3 L-11,5 L-11,-5 Z" fill="#151515" stroke="#f2f2ee" stroke-width="1.6" stroke-linejoin="round"/></g></svg>',
  russia: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="40" fill="#f6f3ea"/><path d="M0,0 L60,40 M60,0 L0,40" stroke="#1f4fa0" stroke-width="7"/></svg>',
  austria: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="20" fill="#151515"/><rect width="60" height="20" y="20" fill="#f2c230"/></svg>',
  spain: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="40" fill="#c8191e"/><rect width="60" height="20" y="10" fill="#f2c230"/></svg>',
  portugal: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="40" fill="#f6f3ea"/><path d="M22,9 h16 v14 q0,9 -8,10 q-8,-1 -8,-10 z" fill="#c8191e"/><path d="M25,12 h10 v11 q0,5 -5,6 q-5,-1 -5,-6 z" fill="#f6f3ea"/><g fill="#1f4a8a"><rect x="28.5" y="14" width="3" height="3"/><rect x="25.5" y="19" width="3" height="3"/><rect x="31.5" y="19" width="3" height="3"/><rect x="28.5" y="19" width="3" height="3"/><rect x="28.5" y="24" width="3" height="3"/></g></svg>',
  poland: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="20" fill="#f6f3ea"/><rect width="60" height="20" y="20" fill="#b3203c"/></svg>',
  italy: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="40" fill="#c8191e"/><path d="M30,4 L56,20 L30,36 L4,20 Z" fill="#f6f3ea"/><rect x="21" y="11" width="18" height="18" fill="#2e7a3e"/><circle cx="30" cy="20" r="3.5" fill="#e6b422"/></svg>',
  confederation: '<svg viewBox="0 0 60 40" preserveAspectRatio="none" aria-hidden="true"><rect width="60" height="40" fill="#d4a92a"/><rect width="20" height="40" fill="#151515"/><rect width="20" height="40" x="40" fill="#151515"/></svg>',
};

/* A small emblem beside a nation's name, used sparingly (the army preview).
   Prussia's is the Iron Cross; the others have none. */
export const NATION_EMBLEM = {
  prussia: '<svg class="nation-emblem" viewBox="-12 -12 24 24" width="13" height="13" aria-hidden="true" style="vertical-align:-2px;margin-right:4px"><path d="M-3,-3 L-5,-11 L5,-11 L3,-3 L11,-5 L11,5 L3,3 L5,11 L-5,11 L-3,3 L-11,5 L-11,-5 Z" fill="#151515" stroke="#f2f2ee" stroke-width="1.8" stroke-linejoin="round"/></svg>',
};

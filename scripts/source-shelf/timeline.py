"""Shared scene choreography and encoded clip boundaries, in frames."""
FPS = 24
L0 = 62
P = 80
L1 = L0 + P
T = {
    'open': (3, 39),
    'turns': [(31, 53), (L0 + 46, L0 + 66)],
    'lens_out': (L1, L1 + 12),
    'pages_close': (L1 + 6, L1 + 34),
    'cover_close': (L1 + 8, L1 + 40),
    'bookmark': (L1 + 40, L1 + 41),
    'end': L1 + 54,
    'loop': (L0, L1),
}
CLIPS = [('reading', 1, L0 - 1), ('search', L0, L1 - L0), ('complete', L1, T['end'] - L1 + 1)]
STILLS = [('closed', 1), ('reading', L0), ('complete', T['end'])]
SEAMS = {
    'introToLoop': (L0 - 1, L0),
    'loopWrap': (L1 - 1, L0),
    'loopToClose': (L1 - 1, L1),
    'loopRestFrames': (L0, L1),
    'closedVsComplete': (1, T['end']),
}

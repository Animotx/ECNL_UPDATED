ECNL Shape & Color Game Helper — version 2.7.1

GAME BOARD
The reader supports 36 positions in a 12-column by 3-row grid. Positions
are numbered left to right, then top to bottom (1–12, 13–24, 25–36).
The target position is sampled at nine points near the shape center. The
helper only highlights an answer when at least eight samples agree.

HOW TO USE
1. Load this folder as an unpacked extension from chrome://extensions.
2. Open the ECNL Colors task and wait for the board to appear.
3. The helper reads the requested position and detects its color.
4. The helper highlights the matching choice after the game enables it.
   Click that highlighted choice to submit through the game's own answer handler.

The helper starts automatically and analyzes each new puzzle. It waits for
the same board image to remain stable for just over one second, then waits until
the matching choice is enabled and highlights and focuses it. The page
requires a real user click to submit; a content script cannot generate a
trusted hardware click. Analysis errors stop the helper and appear in its status panel.

TROUBLESHOOTING
If the board is not detected or its highlighted position cannot be read,
check that the target image is accessible to browser canvas APIs. Cross-origin
images without CORS support cannot be sampled.

The helper detects the current game's “Checking…” and answer-result messages.
The sample locations are calibrated to the current 12×3 board layout. A
changed board layout may require recalibrating the normalized positions in
solveImage(). Eight-of-nine agreement improves confidence but cannot guarantee
100% correctness for every possible image or board variation.

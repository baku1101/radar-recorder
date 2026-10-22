# Windows runtime dependencies

Our source archive does not contain manufacturer SDK code, firmware, register profiles, captures or backups. The optional offline Windows archive also contains the following unmodified official dependency archives in `packages/`. Their complete license notices are supplied with the distribution and installed application-local runtime. Do not remove them when redistributing the offline bundle.

| Component | License / notices retained | Official source |
| --- | --- | --- |
| Node.js 24.22.1 Windows x64 ZIP | MIT and bundled third-party notices in `node-v24.22.1-win-x64/LICENSE` | https://nodejs.org/dist/v24.22.1/ |
| CPython 3.14.9 embedded Windows x64 ZIP | PSF License Version 2 and bundled notices in `LICENSE.txt` | https://www.python.org/downloads/release/python-3149/ |
| pyserial 3.5 pure-Python wheel | BSD-3-Clause; full notice supplied separately in `licenses/pyserial-3.5-LICENSE.txt` from the official v3.5 tag, then installed as `pyserial-3.5.dist-info/LICENSE.txt` | https://pypi.org/project/pyserial/3.5/ |

Exact URLs and SHA256 digests are recorded in `windows-runtime.lock.json`. The upstream wheel omits the full license text; our distribution includes the official license verbatim and setup copies it into the installed `.dist-info` directory. Node/Python notices are retained from their archives. Only Node's executable and notices are extracted; npm is not needed. The application uses pyserial through its own UART bridge; installing the manufacturer's Visualization Tool is not required for the `radc-0.2.0` raw UART route. Legacy detection-FW features have separate manufacturer dependencies and are outside this portable raw setup.

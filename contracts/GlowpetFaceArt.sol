// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Strings} from "@openzeppelin/contracts@5.6.1/utils/Strings.sol";
import {IGlowpetFaceArt} from "./GlowpetTypes.sol";

/// @title GlowpetFaceArt
/// @notice Eyes and eyewear renderer, split out of GlowpetArt to stay under the
///         24KB contract-size limit. Pure functions, no storage.
contract GlowpetFaceArt is IGlowpetFaceArt {
    using Strings for uint256;

    function eyes(
        uint8 species,
        uint8 eyeStyle,
        uint256 cx,
        uint256 eyeX,
        uint256 eyeY,
        uint256 eyeR,
        string calldata ink
    ) external pure returns (string memory) {
        if (species == 5) {
            return string.concat(
                _pandaEye(cx - eyeX, eyeY, eyeR, eyeStyle, ink, false),
                _pandaEye(cx + eyeX, eyeY, eyeR, eyeStyle, ink, true)
            );
        }
        return string.concat(
            _eye(cx - eyeX, eyeY, eyeR, eyeStyle, ink, false),
            _eye(cx + eyeX, eyeY, eyeR, eyeStyle, ink, true)
        );
    }

    function eyewear(
        uint8 style,
        uint8 frameColor,
        uint256 cx,
        uint256 eyeX,
        uint256 eyeY,
        uint256 eyeR
    ) external pure returns (string memory) {
        if (style == 0) return "";

        uint256 left = cx - eyeX;
        uint256 right = cx + eyeX;
        uint256 ey = eyeY;
        uint256 r = (eyeR * 132) / 100;
        string memory frame = _frameColor(frameColor);
        string memory lens = "#BFE3FF";

        string memory bridge = string.concat(
            '<path d="M ', _s(left + r), ' ', _s(ey - (r * 5) / 100), ' L ', _s(right - r), ' ',
            _s(ey - (r * 5) / 100), '" stroke="', frame, '" stroke-width="4" stroke-linecap="round"/>'
        );
        string memory temples = string.concat(
            '<path d="M ', _s(left - r), ' ', _s(ey - (r * 15) / 100), ' L ', _s(left - r - 16), ' ',
            _s(ey - (r * 35) / 100), '" stroke="', frame, '" stroke-width="3" stroke-linecap="round"/>'
        );
        temples = string.concat(
            temples,
            '<path d="M ', _s(right + r), ' ', _s(ey - (r * 15) / 100), ' L ', _s(right + r + 16), ' ',
            _s(ey - (r * 35) / 100), '" stroke="', frame, '" stroke-width="3" stroke-linecap="round"/>'
        );

        if (style == 1) {
            return string.concat(_lens(left, ey, r, frame, lens), _lens(right, ey, r, frame, lens), bridge, temples);
        }
        if (style == 2) {
            uint256 w = (r * 185) / 100;
            uint256 h = (r * 155) / 100;
            return string.concat(
                _lensRect(left, ey, w, h, frame, lens),
                _lensRect(right, ey, w, h, frame, lens),
                bridge,
                temples
            );
        }
        if (style == 3) {
            return string.concat(
                _ellipse(left, ey, r, r, "#2B2B30"),
                _ellipse(right, ey, r, r, "#2B2B30"),
                bridge,
                temples
            );
        }
        if (style == 4) {
            return string.concat(
                _ellipseRot(left, ey, (r * 98) / 100, (r * 78) / 100, 348, lens),
                _ellipseRot(right, ey, (r * 98) / 100, (r * 78) / 100, 12, lens),
                bridge,
                temples
            );
        }

        string memory chain = string.concat("M ", _s(right + (r * 95) / 100), " ", _s(ey + 6));
        chain = string.concat(chain, " Q ", _s(right + r + 12), " ", _s(ey + 44), " ", _s(right + (r * 40) / 100), " ", _s(ey + 78));
        return string.concat(_lens(right, ey, (r * 95) / 100, frame, lens), _stroke(chain, frame, 3));
    }

    // ------------------------------------------------------------------

    function _eye(uint256 cx, uint256 cy, uint256 r, uint8 style, string memory ink, bool right)
        internal
        pure
        returns (string memory)
    {
        if (style == 2) {
            string memory d = string.concat(
                "M ", _s(cx - r), " ", _s(cy + (r * 25) / 100),
                " q ", _s(r), " -", _s((r * 115) / 100), " ", _s(r * 2), " 0"
            );
            return _stroke(d, ink, (r * 52) / 100);
        }

        if (style == 3) {
            uint256 lx = right ? cx + (r * 82) / 100 : cx - (r * 82) / 100;
            uint256 ly = cy - (r * 55) / 100;
            string memory dir = right ? "1" : "-1";
            string memory d = string.concat("M ", _s(lx), " ", _s(ly), " l ", dir, " ", _s((r * 55) / 100), " -", _s((r * 36) / 100));
            d = string.concat(d, " M ", _s(lx), " ", _s(ly + (r * 32) / 100), " l ", dir, " ", _s((r * 60) / 100), " -", _s((r * 6) / 100));
            d = string.concat(d, " M ", _s(lx), " ", _s(ly + (r * 66) / 100), " l ", dir, " ", _s((r * 50) / 100), " ", _s((r * 24) / 100));
            return string.concat(
                _ellipse(cx, cy, (r * 90) / 100, (r * 102) / 100, ink),
                _circle(cx - (r * 30) / 100, cy - (r * 42) / 100, (r * 32) / 100, "#ffffff"),
                _stroke(d, ink, (r * 24) / 100)
            );
        }

        if (style == 4) {
            string memory d = string.concat("M ", _s(cx - (r * 95) / 100), " ", _s(cy - (r * 16) / 100), " L ", _s(cx + (r * 95) / 100), " ", _s(cy - (r * 16) / 100));
            return string.concat(
                _ellipse(cx, cy + (r * 12) / 100, (r * 90) / 100, (r * 62) / 100, ink),
                _stroke(d, ink, (r * 30) / 100),
                _circle(cx - (r * 26) / 100, cy + (r * 2) / 100, (r * 20) / 100, "#ffffff")
            );
        }

        if (style == 5) {
            string memory d = string.concat("M ", _s(cx), " ", _s(cy - r));
            d = string.concat(d, " Q ", _s(cx + (r * 20) / 100), " ", _s(cy - (r * 20) / 100), " ", _s(cx + r), " ", _s(cy));
            d = string.concat(d, " Q ", _s(cx + (r * 20) / 100), " ", _s(cy + (r * 20) / 100), " ", _s(cx), " ", _s(cy + r));
            d = string.concat(d, " Q ", _s(cx - (r * 20) / 100), " ", _s(cy + (r * 20) / 100), " ", _s(cx - r), " ", _s(cy));
            d = string.concat(d, " Q ", _s(cx - (r * 20) / 100), " ", _s(cy - (r * 20) / 100), " ", _s(cx), " ", _s(cy - r), " Z");
            return _pathD(d, ink);
        }

        string memory out = string.concat(
            _ellipse(cx, cy, (r * 92) / 100, r, ink),
            _circle(cx - (r * 34) / 100, cy - (r * 40) / 100, (r * 34) / 100, "#ffffff")
        );
        if (style == 1) {
            out = string.concat(out, _circle(cx + (r * 30) / 100, cy + (r * 28) / 100, (r * 16) / 100, "#ffffff"));
        }
        return out;
    }

    function _pandaEye(uint256 cx, uint256 cy, uint256 r, uint8 style, string memory ink, bool right)
        internal
        pure
        returns (string memory)
    {
        if (style == 2) {
            string memory d = string.concat(
                "M ", _s(cx - (r * 80) / 100), " ", _s(cy + (r * 20) / 100),
                " q ", _s((r * 80) / 100), " -", _s(r), " ", _s((r * 160) / 100), " 0"
            );
            return _stroke(d, "#ffffff", (r * 42) / 100);
        }
        if (style == 5) {
            string memory d = string.concat("M ", _s(cx), " ", _s(cy - (r * 80) / 100));
            d = string.concat(d, " Q ", _s(cx + (r * 16) / 100), " ", _s(cy - (r * 16) / 100), " ", _s(cx + (r * 80) / 100), " ", _s(cy));
            d = string.concat(d, " Q ", _s(cx + (r * 16) / 100), " ", _s(cy + (r * 16) / 100), " ", _s(cx), " ", _s(cy + (r * 80) / 100));
            d = string.concat(d, " Q ", _s(cx - (r * 16) / 100), " ", _s(cy + (r * 16) / 100), " ", _s(cx - (r * 80) / 100), " ", _s(cy));
            d = string.concat(d, " Q ", _s(cx - (r * 16) / 100), " ", _s(cy - (r * 16) / 100), " ", _s(cx), " ", _s(cy - (r * 80) / 100), " Z");
            return _pathD(d, "#ffffff");
        }
        return string.concat(
            _circle(cx, cy, (r * 74) / 100, "#ffffff"),
            _circle(cx, cy + (r * 6) / 100, (r * 44) / 100, ink),
            _circle(cx - (r * 18) / 100, cy - (r * 16) / 100, (r * 16) / 100, "#ffffff")
        );
    }

    function _lens(uint256 cx, uint256 cy, uint256 r, string memory frame, string memory lens)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<circle cx="', _s(cx), '" cy="', _s(cy), '" r="', _s(r), '" fill="', lens,
            '" fill-opacity="0.22" stroke="', frame, '" stroke-width="4"/>'
        );
    }

    function _lensRect(uint256 cx, uint256 cy, uint256 w, uint256 h, string memory frame, string memory lens)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<rect x="', _s(cx - w / 2), '" y="', _s(cy - h / 2), '" width="', _s(w), '" height="', _s(h),
            '" rx="', _s(w / 6), '" fill="', lens, '" fill-opacity="0.22" stroke="', frame, '" stroke-width="4"/>'
        );
    }

    function _frameColor(uint8 i) internal pure returns (string memory) {
        if (i == 0) return "#2B2B30";
        if (i == 1) return "#C9A227";
        if (i == 2) return "#A8AFB8";
        if (i == 3) return "#7A4A2A";
        if (i == 4) return "#C97B84";
        return "#5B6B8C";
    }

    // ------------------------------------------------------------------
    // DSL
    // ------------------------------------------------------------------

    function _s(uint256 v) internal pure returns (string memory) {
        return v.toString();
    }

    function _circle(uint256 cx, uint256 cy, uint256 r, string memory fill)
        internal
        pure
        returns (string memory)
    {
        return string.concat('<circle cx="', _s(cx), '" cy="', _s(cy), '" r="', _s(r), '" fill="', fill, '"/>');
    }

    function _ellipse(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string memory fill)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<ellipse cx="', _s(cx), '" cy="', _s(cy), '" rx="', _s(rx), '" ry="', _s(ry), '" fill="', fill, '"/>'
        );
    }

    function _ellipseRot(uint256 cx, uint256 cy, uint256 rx, uint256 ry, uint256 a, string memory fill)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<ellipse cx="', _s(cx), '" cy="', _s(cy), '" rx="', _s(rx), '" ry="', _s(ry),
            '" transform="rotate(', _s(a), ' ', _s(cx), ' ', _s(cy), ')" fill="', fill, '"/>'
        );
    }

    function _pathD(string memory d, string memory fill) internal pure returns (string memory) {
        return string.concat('<path d="', d, '" fill="', fill, '"/>');
    }

    function _stroke(string memory d, string memory col, uint256 w) internal pure returns (string memory) {
        return string.concat(
            '<path d="', d, '" stroke="', col, '" stroke-width="', _s(w),
            '" fill="none" stroke-linecap="round"/>'
        );
    }

    // ------------------------------------------------------------------
    // Species features (ears, marks, mane, special faces)
    // ------------------------------------------------------------------

    struct EarCtx {
        uint256 cx;
        uint256 cy;
        uint256 rx;
        uint256 ry;
        string ear;
        string earIn;
    }

    function ears(
        uint8 sp,
        uint8 ev,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata ear,
        string calldata earIn
    ) external pure returns (string memory) {
        return _earsDispatch(sp, ev, EarCtx(cx, cy, rx, ry, ear, earIn));
    }

    function _earsDispatch(uint8 sp, uint8 ev, EarCtx memory e) internal pure returns (string memory) {
        if (sp == 6 || sp == 10) return "";
        if (sp == 0 || sp == 4) {
            return _triSet(e, uint256(sp == 4 ? 142 : 128) * uint256(ev == 1 ? 112 : 100) / 100, sp == 4 ? 96 : 88);
        }
        if (sp == 1 || sp == 7 || sp == 11) {
            uint256 longLen = sp == 7 ? 55 : 100;
            uint256 ery = (52 * longLen * uint256(ev == 1 ? 118 : 100)) / 10000;
            uint256 erx = sp == 7 ? 22 : (sp == 11 ? 20 : 24);
            uint256 ey = e.cy - (e.ry * 10) / 100;
            uint256 ex = (e.rx * 92) / 100;
            return string.concat(
                _ellipseRot(e.cx - ex, ey, erx, ery, 342, e.ear),
                _ellipseRot(e.cx + ex, ey, erx, ery, 18, e.ear)
            );
        }
        if (sp == 2) {
            uint256 ey = e.cy - e.ry - 26;
            uint256 ery = (56 * uint256(ev == 1 ? 112 : 100)) / 100;
            uint256 ex = (e.rx * 42) / 100;
            string memory out = _ellipseRot(e.cx - ex, ey, 25, ery, 351, e.ear);
            out = string.concat(out, _ellipseRot(e.cx + ex, ey, 25, ery, 9, e.ear));
            out = string.concat(out, _ellipseRot(e.cx - ex, ey, 13, (ery * 70) / 100, 351, e.earIn));
            return string.concat(out, _ellipseRot(e.cx + ex, ey, 13, (ery * 70) / 100, 9, e.earIn));
        }
        if (sp == 8) return _triSet(e, 102, 99);
        if (sp == 9) {
            uint256 er = (e.rx * 46) / 100;
            uint256 ex = (e.rx * 66) / 100;
            uint256 ey = e.cy - (e.ry * 82) / 100;
            string memory out = _circle(e.cx - ex, ey, er, e.ear);
            out = string.concat(out, _circle(e.cx + ex, ey, er, e.ear));
            out = string.concat(out, _circle(e.cx - ex, ey, (er * 56) / 100, e.earIn));
            return string.concat(out, _circle(e.cx + ex, ey, (er * 56) / 100, e.earIn));
        }

        uint256 er2 = (e.rx * uint256(sp == 5 ? 38 : 30)) / 100;
        uint256 ex2 = (e.rx * 62) / 100;
        uint256 ey2 = e.cy - (e.ry * 78) / 100;
        string memory out2 = string.concat(_circle(e.cx - ex2, ey2, er2, e.ear), _circle(e.cx + ex2, ey2, er2, e.ear));
        if (sp != 5) {
            out2 = string.concat(out2, _circle(e.cx - ex2, ey2, (er2 * 52) / 100, e.earIn));
            out2 = string.concat(out2, _circle(e.cx + ex2, ey2, (er2 * 52) / 100, e.earIn));
        }
        return out2;
    }

    function _triSet(EarCtx memory e, uint256 tall, uint256 w) internal pure returns (string memory) {
        string memory out = _triEar(e, tall, w, false, e.ear);
        out = string.concat(out, _triEar(e, tall, w, true, e.ear));
        out = string.concat(out, _triEar(e, tall - 14, w - 6, false, e.earIn));
        return string.concat(out, _triEar(e, tall - 14, w - 6, true, e.earIn));
    }

    function _triEar(EarCtx memory e, uint256 tall, uint256 w, bool right, string memory fill)
        internal
        pure
        returns (string memory)
    {
        uint256 sx = right ? e.cx + (e.rx * w) / 100 : e.cx - (e.rx * w) / 100;
        uint256 bx = right ? e.cx + (e.rx * 74) / 100 : e.cx - (e.rx * 74) / 100;
        uint256 ix = right ? e.cx + (e.rx * 10) / 100 : e.cx - (e.rx * 10) / 100;
        string memory d = string.concat("M ", _s(bx), " ", _s(e.cy - (e.ry * 50) / 100));
        d = string.concat(d, " L ", _s(sx), " ", _s(e.cy - (e.ry * tall) / 100));
        d = string.concat(d, " L ", _s(ix), " ", _s(e.cy - (e.ry * 88) / 100), " Z");
        return _pathD(d, fill);
    }

    function marks(
        uint8 sp,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata ink,
        string calldata muzzle
    ) external pure returns (string memory) {
        if (sp == 0 || sp == 9) return _whiskers(cx, cy, rx, ink);
        if (sp == 4) return _cheeks(cx, cy, rx, muzzle);
        if (sp == 12) return _tigerMarks(cx, cy, rx, ry, muzzle);
        if (sp == 11) return _cowMarks(cx, cy, rx, ry);
        if (sp == 2) return _teeth(cx, cy);
        return "";
    }

    function pandaPatches(uint256 cx, uint256 ex, uint256 ey, uint256 er, string calldata ink)
        external
        pure
        returns (string memory)
    {
        return string.concat(
            _ellipseRot(cx - ex, ey, (er * 15) / 10, (er * 185) / 100, 346, ink),
            _ellipseRot(cx + ex, ey, (er * 15) / 10, (er * 185) / 100, 14, ink)
        );
    }

    function frogBulges(uint256 cx, uint256 ex, uint256 ey, uint256 er, string calldata body)
        external
        pure
        returns (string memory)
    {
        return string.concat(
            _circle(cx - ex, ey + 8, (er * 162) / 100, body),
            _circle(cx + ex, ey + 8, (er * 162) / 100, body)
        );
    }

    function sheepFleece(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string calldata fleece)
        external
        pure
        returns (string memory)
    {
        return _fleece(cx, cy, rx, ry, fleece);
    }

    function _fleece(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string memory fleece)
        internal
        pure
        returns (string memory)
    {
        string memory out = _circle(cx - (rx * 74) / 100, cy - (ry * 50) / 100, (rx * 21) / 100, fleece);
        out = string.concat(out, _circle(cx - (rx * 60) / 100, cy - (ry * 80) / 100, (rx * 21) / 100, fleece));
        out = string.concat(out, _circle(cx - (rx * 32) / 100, cy - (ry * 98) / 100, (rx * 21) / 100, fleece));
        out = string.concat(out, _circle(cx, cy - (ry * 102) / 100, (rx * 21) / 100, fleece));
        out = string.concat(out, _circle(cx + (rx * 32) / 100, cy - (ry * 98) / 100, (rx * 21) / 100, fleece));
        out = string.concat(out, _circle(cx + (rx * 60) / 100, cy - (ry * 80) / 100, (rx * 21) / 100, fleece));
        out = string.concat(out, _circle(cx + (rx * 74) / 100, cy - (ry * 50) / 100, (rx * 21) / 100, fleece));
        return out;
    }

    function penguinPatch(uint256 cx, uint256 cy, uint256 rx, uint256 ry)
        external
        pure
        returns (string memory)
    {
        return _ellipse(cx, cy + 18, (rx * 62) / 100, (ry * 72) / 100, "#FFFFFF");
    }

    function mane(
        uint8 sp,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata color
    ) external pure returns (string memory) {
        if (sp != 13) return "";
        return _lionMane(cx, cy, rx, ry, color);
    }

    function _lionMane(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string memory color)
        internal
        pure
        returns (string memory)
    {
        int256[14] memory px = [int256(-100), -98, -85, -62, -35, 0, 35, 62, 85, 98, 100, -88, 88, 0];
        int256[14] memory py = [int256(-15), -45, -72, -92, -102, -106, -102, -92, -72, -45, -15, 28, 28, 104];
        string memory out = "";
        for (uint256 i = 0; i < 14; i++) {
            uint256 x = px[i] < 0 ? cx - (uint256(-px[i]) * rx) / 100 : cx + (uint256(px[i]) * rx) / 100;
            uint256 y = py[i] < 0 ? cy - (uint256(-py[i]) * ry) / 100 : cy + (uint256(py[i]) * ry) / 100;
            out = string.concat(out, _circle(x, y, (rx * 22) / 100, color));
        }
        return out;
    }

    struct FaceCtx {
        uint256 cx;
        uint256 cy;
        uint256 rx;
        uint256 ry;
        string ink;
        string ear;
        string nose;
    }

    function specialFace(
        uint8 sp,
        uint256 cx,
        uint256 cy,
        uint256 rx,
        uint256 ry,
        string calldata ink,
        string calldata ear,
        string calldata nose
    ) external pure returns (string memory) {
        FaceCtx memory f = FaceCtx(cx, cy, rx, ry, ink, ear, nose);
        if (sp == 6) return _frogFace(f);
        if (sp == 8) return _pigFace(f);
        if (sp == 10) return _penguinBeak(f);
        return "";
    }

    function _frogFace(FaceCtx memory f) internal pure returns (string memory) {
        string memory d = string.concat("M ", _s(f.cx - 44), " ", _s(f.cy + 34));
        d = string.concat(d, " Q ", _s(f.cx), " ", _s(f.cy + 66), " ", _s(f.cx + 44), " ", _s(f.cy + 34));
        return _stroke(d, f.ink, 5);
    }

    function _pigFace(FaceCtx memory f) internal pure returns (string memory) {
        string memory out = _ellipse(f.cx, f.cy + 40, (f.rx * 30) / 100, (f.ry * 21) / 100, f.ear);
        out = string.concat(out, _ellipse(f.cx - 9, f.cy + 40, 4, 6, f.nose));
        out = string.concat(out, _ellipse(f.cx + 9, f.cy + 40, 4, 6, f.nose));
        string memory smile = string.concat("M ", _s(f.cx - 10), " ", _s(f.cy + 60));
        smile = string.concat(smile, " Q ", _s(f.cx), " ", _s(f.cy + 68), " ", _s(f.cx + 10), " ", _s(f.cy + 60));
        return string.concat(out, _stroke(smile, f.ink, 3));
    }

    function _penguinBeak(FaceCtx memory f) internal pure returns (string memory) {
        string memory d = string.concat("M ", _s(f.cx - 12), " ", _s(f.cy + 34));
        d = string.concat(d, " L ", _s(f.cx + 12), " ", _s(f.cy + 34), " L ", _s(f.cx), " ", _s(f.cy + 54), " Z");
        return _pathD(d, "#F2A63B");
    }

    function _tigerMarks(uint256 cx, uint256 cy, uint256 rx, uint256 ry, string memory muzzle)
        internal
        pure
        returns (string memory)
    {
        return string.concat(_stripes(cx, cy, rx, ry), _cheeks(cx, cy, rx, muzzle));
    }

    function _cowMarks(uint256 cx, uint256 cy, uint256 rx, uint256 ry)
        internal
        pure
        returns (string memory)
    {
        return string.concat(_horns(cx, cy, rx, ry), _nostrils(cx, cy));
    }

    function _whiskers(uint256 cx, uint256 cy, uint256 rx, string memory ink) internal pure returns (string memory) {
        string memory out = "";
        for (uint256 i = 0; i < 3; i++) {
            uint256 y = cy + 36 + i * 9;
            uint256 len = 27 - i * 2;
            string memory lft = string.concat("M ", _s(cx - (rx * 50) / 100), " ", _s(y), " L ", _s(cx - (rx * 50) / 100 - len), " ", _s(y - 3 + i * 3));
            string memory rgt = string.concat("M ", _s(cx + (rx * 50) / 100), " ", _s(y), " L ", _s(cx + (rx * 50) / 100 + len), " ", _s(y - 3 + i * 3));
            out = string.concat(out, _stroke(lft, ink, 2), _stroke(rgt, ink, 2));
        }
        return out;
    }

    function _cheeks(uint256 cx, uint256 cy, uint256 rx, string memory muzzle) internal pure returns (string memory) {
        string memory lft = string.concat("M ", _s(cx - (rx * 54) / 100), " ", _s(cy + 8));
        lft = string.concat(lft, " Q ", _s(cx - (rx * 98) / 100), " ", _s(cy + 2), " ", _s(cx - (rx * 93) / 100), " ", _s(cy + 34));
        lft = string.concat(lft, " Q ", _s(cx - (rx * 72) / 100), " ", _s(cy + 26), " ", _s(cx - (rx * 54) / 100), " ", _s(cy + 20), " Z");
        string memory rgt = string.concat("M ", _s(cx + (rx * 54) / 100), " ", _s(cy + 8));
        rgt = string.concat(rgt, " Q ", _s(cx + (rx * 98) / 100), " ", _s(cy + 2), " ", _s(cx + (rx * 93) / 100), " ", _s(cy + 34));
        rgt = string.concat(rgt, " Q ", _s(cx + (rx * 72) / 100), " ", _s(cy + 26), " ", _s(cx + (rx * 54) / 100), " ", _s(cy + 20), " Z");
        return string.concat(_pathD(lft, muzzle), _pathD(rgt, muzzle));
    }

    function _stripes(uint256 cx, uint256 cy, uint256 rx, uint256 ry) internal pure returns (string memory) {
        string memory out = "";
        for (uint256 i = 0; i < 3; i++) {
            uint256 y = cy - (ry * 2) / 100 + i * 15;
            string memory lft = string.concat("M ", _s(cx - (rx * 52) / 100), " ", _s(y), " L ", _s(cx - (rx * 78) / 100), " ", _s(y - 8));
            string memory rgt = string.concat("M ", _s(cx + (rx * 52) / 100), " ", _s(y), " L ", _s(cx + (rx * 78) / 100), " ", _s(y - 8));
            out = string.concat(out, _stroke(lft, "#5a3a24", 5), _stroke(rgt, "#5a3a24", 5));
        }
        return out;
    }

    function _horns(uint256 cx, uint256 cy, uint256 rx, uint256 ry) internal pure returns (string memory) {
        string memory lft = string.concat("M ", _s(cx - (rx * 30) / 100), " ", _s(cy - (ry * 90) / 100));
        lft = string.concat(lft, " Q ", _s(cx - (rx * 50) / 100), " ", _s(cy - (ry * 112) / 100), " ", _s(cx - (rx * 22) / 100), " ", _s(cy - (ry * 104) / 100), " Z");
        string memory rgt = string.concat("M ", _s(cx + (rx * 30) / 100), " ", _s(cy - (ry * 90) / 100));
        rgt = string.concat(rgt, " Q ", _s(cx + (rx * 50) / 100), " ", _s(cy - (ry * 112) / 100), " ", _s(cx + (rx * 22) / 100), " ", _s(cy - (ry * 104) / 100), " Z");
        return string.concat(_pathD(lft, "#F5E6C8"), _pathD(rgt, "#F5E6C8"));
    }

    function _nostrils(uint256 cx, uint256 cy) internal pure returns (string memory) {
        return string.concat(
            _ellipse(cx - 10, cy + 46, 4, 6, "#8a5a3a"),
            _ellipse(cx + 10, cy + 46, 4, 6, "#8a5a3a")
        );
    }

    function _teeth(uint256 cx, uint256 cy) internal pure returns (string memory) {
        return string.concat(
            _rect(cx - 9, cy + 58, 8, 11, 3, "#ffffff"),
            _rect(cx + 1, cy + 58, 8, 11, 3, "#ffffff")
        );
    }

    function _rect(uint256 x, uint256 y, uint256 w, uint256 h, uint256 r, string memory fill)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            '<rect x="', _s(x), '" y="', _s(y), '" width="', _s(w), '" height="', _s(h),
            '" rx="', _s(r), '" fill="', fill, '"/>'
        );
    }

}

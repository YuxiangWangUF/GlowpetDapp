// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Strings} from "@openzeppelin/contracts@5.6.1/utils/Strings.sol";
import {Traits, IGlowpetArt, IGlowpetFaceArt} from "./GlowpetTypes.sol";

/**
 * @title GlowpetArt
 * @notice On-chain head-only portrait renderer.
 *
 * Design: a big head, two tiny feet, 2.5D shading. No body, no hair.
 * A tiny drawing DSL keeps the bytecode small enough for the 24KB limit while
 * still covering 8 species, 6 eye styles, 6 eyewear styles and 6 accessories.
 *
 * The SVG groups (gp-head, gp-face, ...) are the animation contract used by the
 * app; the chain art stays a canonical portrait.
 */
contract GlowpetArt is IGlowpetArt {
    using Strings for uint256;

    /// @notice Face renderer (eyes + eyewear), deployed separately to respect
    ///         the 24KB bytecode limit.
    address public immutable faceArt;

    error InvalidConfig();

    constructor(address faceArt_) {
        // A renderer without deployed code would permanently break tokenURI.
        if (faceArt_.code.length == 0) revert InvalidConfig();
        faceArt = faceArt_;
    }

    struct Col {
        string body;
        string light;
        string dark;
        string ink;
        string ear;
        string earIn;
        string muzzle;
        string bg1;
        string bg2;
        string glow;
        string line;
        string nose;
        string blush;
        string fleece;
    }

    struct Ctx {
        Traits t;
        Col c;
        uint256 cx;
        uint256 cy;
        uint256 rx;
        uint256 ry;
        uint256 eyeX;
        uint256 eyeY;
        uint256 eyeR;
        string label;
        uint256 serial;
        uint256 stage;
    }

    function render(Traits calldata t_, string calldata label, uint32 serial, uint8 stage)
        external
        view
        returns (string memory)
    {
        Ctx memory x;
        x.t = t_;
        x.label = label;
        x.serial = serial;
        x.stage = stage;
        _layout(x);
        x.c = _colors(x.t);

        string memory out = string.concat(
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="400" height="400">',
            _defs(x)
        );
        out = string.concat(out, '<rect width="400" height="400" rx="30" fill="url(#bg)"/>');
        out = string.concat(out, '<rect width="400" height="400" rx="30" fill="url(#glow)"/>');
        out = string.concat(out, _topLabels(x));
        out = string.concat(out, '<g id="gp-root" transform="rotate(', _tilt(x.t.tilt), ' ', _s(x.cx), ' ', _s(x.cy), ')">');
        out = string.concat(out, _ground(x));
        out = string.concat(out, _feet(x));
        out = string.concat(out, _head(x));
        return string.concat(out, '</g>', _footer(x), '</svg>');
    }

    // ------------------------------------------------------------------
    // Layout / colour
    // ------------------------------------------------------------------

    function _layout(Ctx memory x) internal pure {
        (uint256 brx, uint256 bry) = _geo(x.t.species);
        uint256 s = x.t.bodyScale;

        x.cx = 200;
        x.cy = 205;
        x.rx = (brx * s) / 1000;
        x.ry = (bry * s) / 1000;
        if (x.t.bodyShape == 1) {
            x.rx = (x.rx * 90) / 100;
            x.ry = (x.ry * 104) / 100;
        }

        x.eyeX = (40 * x.t.eyeSpacing * s) / 1000000;
        x.eyeY = x.cy - (x.ry * 15) / 100;
        x.eyeR = (23 * x.t.eyeSize * s) / 1000000;

        if (x.t.species == 6) {
            x.eyeX = (x.rx * 52) / 100;
            x.eyeY = x.cy - (x.ry * 98) / 100;
            x.eyeR = (21 * x.t.eyeSize * s) / 1000000;
        } else if (x.t.species == 7) {
            x.eyeX = (38 * x.t.eyeSpacing * s) / 1000000;
        }
    }

    function _geo(uint8 sp) internal pure returns (uint256 rx, uint256 ry) {
        if (sp == 0) return (104, 84);
        if (sp == 1) return (106, 86);
        if (sp == 2) return (100, 88);
        if (sp == 3) return (108, 90);
        if (sp == 4) return (102, 82);
        if (sp == 5) return (108, 90);
        if (sp == 6) return (112, 78);
        if (sp == 8) return (106, 84);
        if (sp == 9) return (108, 86);
        if (sp == 10) return (104, 90);
        if (sp == 11) return (108, 88);
        if (sp == 12) return (104, 84);
        if (sp == 13) return (110, 92);
        return (104, 88);
    }

    function _pal(uint8 i) internal pure returns (uint256 h, uint256 s, uint256 l) {
        if (i == 0) return (345, 660, 710);
        if (i == 1) return (8, 720, 710);
        if (i == 2) return (26, 780, 750);
        if (i == 3) return (45, 780, 770);
        if (i == 4) return (140, 460, 710);
        if (i == 5) return (172, 500, 710);
        if (i == 6) return (202, 600, 730);
        if (i == 7) return (232, 580, 740);
        if (i == 8) return (268, 540, 730);
        return (312, 570, 720);
    }

    function _colors(Traits memory t) internal pure returns (Col memory c) {
        if (t.species == 5) {
            c.body = "#F3F1EC"; c.light = "#FFFFFF"; c.dark = "#D9D5CC"; c.ink = "#B9B3A6";
            c.ear = "#2C2C30"; c.earIn = "#3B3B42"; c.muzzle = "#FFFFFF";
            c.bg1 = "#1A2029"; c.bg2 = "#0C1117"; c.glow = "#9DB4D6";
            c.line = "#2C2C30"; c.nose = "#2C2C30"; c.blush = "#FFB3C1"; c.fleece = "#FFFFFF";
            return c;
        }

        (uint256 h, uint256 s, uint256 l) = _pal(t.palette);
        uint256 shift = t.bgVariant == 0 ? 0 : (t.bgVariant == 1 ? 10 : 350);

        c.body = _hsl(h, s, l);
        c.light = _hsl(h, s + 80, l + 130);
        c.dark = _hsl(h, s, l > 140 ? l - 140 : 0);
        c.ink = "#3b2a33";
        c.ear = _hsl(h + 354, s > 40 ? s - 40 : 0, l > 100 ? l - 100 : 0);
        c.earIn = _hsl(h, s > 80 ? s - 80 : 0, l + 170);
        c.muzzle = _hsl(h, 420, 960);
        c.bg1 = _hsl(h + shift, 270, 160);
        c.bg2 = _hsl(h + shift, 310, 80);
        c.glow = _hsl(h, 650, 580);
        c.line = _hsl(h, s, l > 200 ? l - 200 : 0);
        c.nose = _hsl(h + 348, 420, 420);
        c.blush = _hsl(h + 12, 780, 740);
        c.fleece = _hsl(h, 340, 940);

        if (t.species == 4) c.muzzle = "#FFF9F2";
        if (t.species == 6) {
            c.muzzle = _hsl(h, 460, 880);
            c.ink = "#27402F";
            c.line = "#27402F";
            c.blush = _hsl(h + 342, 700, 720);
        }
        if (t.species == 7) c.earIn = _hsl(h, 260, 940);
        return c;
    }

    function _hsl(uint256 h, uint256 s, uint256 l) internal pure returns (string memory) {
        if (s > 1000) s = 1000;
        if (l > 1000) l = 1000;

        uint256 C = (s * (1000 - _absDiff(2 * l, 1000))) / 1000;
        uint256 m = l - C / 2;

        uint256 r = ((m + (C * _triR(h)) / 1000) * 255) / 1000;
        uint256 g = ((m + (C * _triG(h)) / 1000) * 255) / 1000;
        uint256 b = ((m + (C * _triB(h)) / 1000) * 255) / 1000;

        return string.concat("#", _hex2(r), _hex2(g), _hex2(b));
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _triR(uint256 h) internal pure returns (uint256) {
        uint256 d = _absDiff(h % 360, 180);
        if (d <= 60) return 0;
        if (d >= 120) return 1000;
        return ((d - 60) * 1000) / 60;
    }

    function _triG(uint256 h) internal pure returns (uint256) {
        uint256 d = _absDiff(h % 360, 120);
        if (d <= 60) return 1000;
        if (d >= 120) return 0;
        return ((120 - d) * 1000) / 60;
    }

    function _triB(uint256 h) internal pure returns (uint256) {
        uint256 d = _absDiff(h % 360, 240);
        if (d <= 60) return 1000;
        if (d >= 120) return 0;
        return ((120 - d) * 1000) / 60;
    }

    function _hex2(uint256 v) internal pure returns (string memory) {
        bytes memory b = new bytes(2);
        b[0] = _hexDigit((v >> 4) & 0x0f);
        b[1] = _hexDigit(v & 0x0f);
        return string(b);
    }

    function _hexDigit(uint256 v) internal pure returns (bytes1) {
        return v < 10 ? bytes1(uint8(48 + v)) : bytes1(uint8(87 + v));
    }

    // ------------------------------------------------------------------
    // DSL
    // ------------------------------------------------------------------

    function _s(uint256 v) internal pure returns (string memory) {
        return v.toString();
    }

    function _tilt(int8 t) internal pure returns (string memory) {
        return t < 0 ? string.concat("-", _s(uint256(-int256(t)))) : _s(uint256(int256(t)));
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

    // ------------------------------------------------------------------
    // Frame
    // ------------------------------------------------------------------

    function _defs(Ctx memory x) internal pure returns (string memory) {
        string memory out = string.concat(
            '<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">',
            '<stop offset="0%" stop-color="', x.c.bg1, '"/><stop offset="100%" stop-color="', x.c.bg2,
            '"/></linearGradient>'
        );
        out = string.concat(
            out,
            '<radialGradient id="glow" cx="50%" cy="42%" r="55%"><stop offset="0%" stop-color="',
            x.c.glow, '" stop-opacity="0.26"/><stop offset="100%" stop-color="', x.c.glow,
            '" stop-opacity="0"/></radialGradient>'
        );
        out = string.concat(
            out,
            '<radialGradient id="gp-head-fill" cx="34%" cy="26%" r="82%"><stop offset="0%" stop-color="',
            x.c.light, '"/><stop offset="52%" stop-color="', x.c.body,
            '"/><stop offset="100%" stop-color="', x.c.dark, '"/></radialGradient>'
        );
        out = string.concat(
            out,
            '<clipPath id="hc"><ellipse cx="', _s(x.cx), '" cy="', _s(x.cy), '" rx="', _s(x.rx),
            '" ry="', _s(x.ry), '"/></clipPath></defs>'
        );
        return out;
    }

    function _topLabels(Ctx memory x) internal pure returns (string memory) {
        return string.concat(
            '<text x="30" y="44" font-family="monospace" font-size="11" fill="#9aa0ae" letter-spacing="3">GLOWPET</text>',
            '<text x="370" y="44" text-anchor="end" font-family="monospace" font-size="11" fill="#9aa0ae" letter-spacing="2">',
            _speciesTag(x.t.species),
            '</text>'
        );
    }

    function _footer(Ctx memory x) internal pure returns (string memory) {
        return string.concat(
            '<text x="200" y="388" text-anchor="middle" font-family="monospace" font-size="10" fill="#8b8b96" letter-spacing="2">',
            _escapeXml(x.label),
            unicode' · No.',
            _pad6(x.serial),
            '</text>'
        );
    }

    function _speciesTag(uint8 sp) internal pure returns (string memory) {
        if (sp == 0) return "CAT";
        if (sp == 1) return "DOG";
        if (sp == 2) return "RABBIT";
        if (sp == 3) return "BEAR";
        if (sp == 4) return "FOX";
        if (sp == 5) return "PANDA";
        if (sp == 6) return "FROG";
        if (sp == 7) return "SHEEP";
        if (sp == 8) return "PIG";
        if (sp == 9) return "MOUSE";
        if (sp == 10) return "PENGUIN";
        if (sp == 11) return "COW";
        if (sp == 12) return "TIGER";
        return "LION";
    }

    /// @dev The series label is operator-supplied text rendered inside <text>.
    ///      Escaping it stops a label from closing the element and injecting
    ///      SVG/script content into wallets and marketplaces that inline the
    ///      token artwork instead of loading it as an isolated image.
    function _escapeXml(string memory value) internal pure returns (string memory) {
        bytes memory input = bytes(value);
        bytes memory output = new bytes(input.length * 6);
        uint256 j;

        for (uint256 i = 0; i < input.length; i++) {
            bytes1 c = input[i];
            if (c == "&") {
                output[j++] = "&";
                output[j++] = "a";
                output[j++] = "m";
                output[j++] = "p";
                output[j++] = ";";
            } else if (c == "<") {
                output[j++] = "&";
                output[j++] = "l";
                output[j++] = "t";
                output[j++] = ";";
            } else if (c == ">") {
                output[j++] = "&";
                output[j++] = "g";
                output[j++] = "t";
                output[j++] = ";";
            } else if (c == "\"") {
                output[j++] = "&";
                output[j++] = "q";
                output[j++] = "u";
                output[j++] = "o";
                output[j++] = "t";
                output[j++] = ";";
            } else if (c == "'") {
                output[j++] = "&";
                output[j++] = "a";
                output[j++] = "p";
                output[j++] = "o";
                output[j++] = "s";
                output[j++] = ";";
            } else {
                output[j++] = c;
            }
        }

        bytes memory trimmed = new bytes(j);
        for (uint256 i = 0; i < j; i++) trimmed[i] = output[i];
        return string(trimmed);
    }

    function _pad6(uint256 v) internal pure returns (string memory) {
        string memory s = v.toString();
        bytes memory b = bytes(s);
        if (b.length >= 6) return s;
        bytes memory out = new bytes(6);
        uint256 pad = 6 - b.length;
        for (uint256 i = 0; i < pad; i++) out[i] = "0";
        for (uint256 i = 0; i < b.length; i++) out[pad + i] = b[i];
        return string(out);
    }

    // ------------------------------------------------------------------
    // Feet + head
    // ------------------------------------------------------------------

    function _ground(Ctx memory x) internal pure returns (string memory) {
        return string.concat(
            '<ellipse cx="', _s(x.cx), '" cy="', _s(x.cy + (x.ry * 104) / 100),
            '" rx="', _s((x.rx * 78) / 100), '" ry="', _s((x.ry * 15) / 100),
            '" fill="#000000" opacity="0.25"/>'
        );
    }

    function _feet(Ctx memory x) internal pure returns (string memory) {
        uint256 y = x.cy + (x.ry * 95) / 100;
        uint256 erx = (30 * x.t.bodyScale) / 1000;
        uint256 ery = (17 * x.t.bodyScale) / 1000;
        return string.concat(
            _ellipse(x.cx - 40, y, erx, ery, x.c.body),
            _ellipse(x.cx + 40, y, erx, ery, x.c.body)
        );
    }

    function _head(Ctx memory x) internal view returns (string memory) {
        string memory out = string.concat('<g id="gp-head" data-pivot="', _s(x.cx), ',', _s(x.cy), '">');
        // Ears and mane belong to the head assembly: they must bob and breathe
        // with it, but stay behind the head shape.
        out = string.concat(out, '<g id="gp-mane">', _mane(x), '</g>');
        out = string.concat(out, '<g id="gp-ears">', _ears(x), '</g>');
        out = string.concat(out, '<g id="gp-head-shape">', _headShape(x), '</g>');
        out = string.concat(out, '<g id="gp-behind-eyes">', _behindEyes(x), '</g>');
        out = string.concat(out, '<g id="gp-face">', _face(x), '</g>');
        out = string.concat(out, '<g id="gp-eyewear">', _eyewear(x), '</g>');
        out = string.concat(out, '<g id="gp-accessory-front">', _accessory(x), '</g>');
        return string.concat(out, '</g>');
    }

    function _headShape(Ctx memory x) internal pure returns (string memory) {
        string memory out = string.concat(
            '<ellipse cx="', _s(x.cx), '" cy="', _s(x.cy), '" rx="', _s(x.rx), '" ry="', _s(x.ry),
            '" fill="url(#gp-head-fill)" stroke="', x.c.line, '" stroke-opacity="0.3" stroke-width="2"/>'
        );
        out = string.concat(out, '<g clip-path="url(#hc)">', _pattern(x));
        out = string.concat(
            out,
            '<ellipse cx="', _s(x.cx), '" cy="', _s(x.cy + (x.ry * 86) / 100), '" rx="', _s(x.rx),
            '" ry="', _s((x.ry * 24) / 100), '" fill="', x.c.line, '" opacity="0.16"/></g>'
        );
        out = string.concat(
            out,
            '<ellipse cx="', _s(x.cx - (x.rx * 34) / 100), '" cy="', _s(x.cy - (x.ry * 52) / 100),
            '" rx="', _s((x.rx * 34) / 100), '" ry="', _s((x.ry * 20) / 100),
            '" transform="rotate(-22 ', _s(x.cx - (x.rx * 34) / 100), ' ', _s(x.cy - (x.ry * 52) / 100),
            ')" fill="#ffffff" opacity="0.24"/>'
        );
        if (x.stage > 0) {
            out = string.concat(
                out,
                '<ellipse cx="', _s(x.cx), '" cy="', _s(x.cy), '" rx="', _s(x.rx + 8),
                '" ry="', _s(x.ry + 8), '" fill="none" stroke="#fbbf24" stroke-width="4"/>'
            );
        }
        return out;
    }

    function _pattern(Ctx memory x) internal pure returns (string memory) {
        if (x.t.patternStyle == 0) return "";

        if (x.t.patternStyle == 1) {
            string memory out = "";
            uint256 rnd = uint256(x.t.patternSeed) + 7;
            for (uint256 i = 0; i < x.t.patternCount; i++) {
                rnd = (rnd * 1664525 + 1013904223) % 4294967296;
                uint256 px = x.cx - x.rx + ((rnd % 1000) * x.rx * 2) / 1000;
                rnd = (rnd * 1664525 + 1013904223) % 4294967296;
                uint256 py = x.cy - (x.ry * 40) / 100 + ((rnd % 1000) * x.ry) / 1000;
                rnd = (rnd * 1664525 + 1013904223) % 4294967296;
                uint256 r = (x.rx * (5 + (rnd % 4))) / 100;
                out = string.concat(
                    out,
                    '<circle cx="', _s(px), '" cy="', _s(py), '" r="', _s(r), '" fill="', x.c.ear, '" opacity="0.32"/>'
                );
            }
            return out;
        }

        string memory d = string.concat("M ", _s(x.cx), " ", _s(x.cy - (x.ry * 92) / 100));
        d = string.concat(d, " Q ", _s(x.cx + (x.rx * 20) / 100), " ", _s(x.cy - (x.ry * 30) / 100));
        d = string.concat(d, " ", _s(x.cx + (x.rx * 9) / 100), " ", _s(x.cy + (x.ry * 10) / 100));
        d = string.concat(d, " Q ", _s(x.cx), " ", _s(x.cy - (x.ry * 8) / 100));
        d = string.concat(d, " ", _s(x.cx - (x.rx * 9) / 100), " ", _s(x.cy + (x.ry * 10) / 100));
        d = string.concat(d, " Q ", _s(x.cx - (x.rx * 20) / 100), " ", _s(x.cy - (x.ry * 30) / 100));
        d = string.concat(d, " ", _s(x.cx), " ", _s(x.cy - (x.ry * 92) / 100), " Z");
        return _pathD(d, x.c.light);
    }

    // ------------------------------------------------------------------
    // Ears
    // ------------------------------------------------------------------

    function _ears(Ctx memory x) internal view returns (string memory) {
        return IGlowpetFaceArt(faceArt).ears(
            x.t.species, x.t.earVariant, x.cx, x.cy, x.rx, x.ry, x.c.ear, x.c.earIn
        );
    }

    function _marks(Ctx memory x) internal view returns (string memory) {
        return IGlowpetFaceArt(faceArt).marks(x.t.species, x.cx, x.cy, x.rx, x.ry, x.c.ink, x.c.muzzle);
    }

    function _behindEyes(Ctx memory x) internal view returns (string memory) {
        IGlowpetFaceArt f = IGlowpetFaceArt(faceArt);
        if (x.t.species == 5) return f.pandaPatches(x.cx, x.eyeX, x.eyeY, x.eyeR, x.c.ink);
        if (x.t.species == 6) return f.frogBulges(x.cx, x.eyeX, x.eyeY, x.eyeR, x.c.body);
        if (x.t.species == 7) return f.sheepFleece(x.cx, x.cy, x.rx, x.ry, x.c.fleece);
        if (x.t.species == 10) return f.penguinPatch(x.cx, x.cy, x.rx, x.ry);
        return "";
    }

    function _mane(Ctx memory x) internal view returns (string memory) {
        return IGlowpetFaceArt(faceArt).mane(x.t.species, x.cx, x.cy, x.rx, x.ry, x.c.dark);
    }

    function _earsLocal(Ctx memory x) internal pure returns (string memory) {
        uint8 sp = x.t.species;
        if (sp == 6) return "";

        if (sp == 0 || sp == 4) {
            uint256 tall = uint256(sp == 4 ? 142 : 128) * uint256(x.t.earVariant == 1 ? 112 : 100) / 100;
            uint256 w = sp == 4 ? 96 : 88;
            string memory out = _triEar(x, tall, w, false, x.c.ear);
            out = string.concat(out, _triEar(x, tall, w, true, x.c.ear));
            out = string.concat(out, _triEar(x, tall - 14, w - 6, false, x.c.earIn));
            out = string.concat(out, _triEar(x, tall - 14, w - 6, true, x.c.earIn));
            return out;
        }

        if (sp == 1 || sp == 7) {
            uint256 ery = (52 * uint256(sp == 7 ? 55 : 100) * uint256(x.t.earVariant == 1 ? 118 : 100)) / 10000;
            uint256 erx = sp == 7 ? 22 : 24;
            uint256 ey = x.cy - (x.ry * 10) / 100;
            uint256 ex = (x.rx * 92) / 100;
            return string.concat(
                _ellipseRot(x.cx - ex, ey, erx, ery, 342, x.c.ear),
                _ellipseRot(x.cx + ex, ey, erx, ery, 18, x.c.ear)
            );
        }

        if (sp == 2) {
            uint256 ey = x.cy - x.ry - 26;
            uint256 ery = (56 * uint256(x.t.earVariant == 1 ? 112 : 100)) / 100;
            uint256 ex = (x.rx * 42) / 100;
            string memory out = _ellipseRot(x.cx - ex, ey, 25, ery, 351, x.c.ear);
            out = string.concat(out, _ellipseRot(x.cx + ex, ey, 25, ery, 9, x.c.ear));
            out = string.concat(out, _ellipseRot(x.cx - ex, ey, 13, (ery * 70) / 100, 351, x.c.earIn));
            out = string.concat(out, _ellipseRot(x.cx + ex, ey, 13, (ery * 70) / 100, 9, x.c.earIn));
            return out;
        }

        uint256 er = (x.rx * (sp == 5 ? 38 : 34) * (x.t.earVariant == 1 ? 108 : 100)) / 10000;
        uint256 ex = (x.rx * 64) / 100;
        uint256 ey = x.cy - (x.ry * 78) / 100;
        string memory out = string.concat(_circle(x.cx - ex, ey, er, x.c.ear), _circle(x.cx + ex, ey, er, x.c.ear));
        if (sp != 5) {
            out = string.concat(out, _circle(x.cx - ex, ey, (er * 52) / 100, x.c.earIn));
            out = string.concat(out, _circle(x.cx + ex, ey, (er * 52) / 100, x.c.earIn));
        }
        return out;
    }

    function _triEar(Ctx memory x, uint256 tall, uint256 w, bool right, string memory fill)
        internal
        pure
        returns (string memory)
    {
        uint256 sx = right ? x.cx + (x.rx * w) / 100 : x.cx - (x.rx * w) / 100;
        uint256 bx = right ? x.cx + (x.rx * 74) / 100 : x.cx - (x.rx * 74) / 100;
        uint256 ix = right ? x.cx + (x.rx * 10) / 100 : x.cx - (x.rx * 10) / 100;
        string memory d = string.concat("M ", _s(bx), " ", _s(x.cy - (x.ry * 50) / 100));
        d = string.concat(d, " L ", _s(sx), " ", _s(x.cy - (x.ry * tall) / 100));
        d = string.concat(d, " L ", _s(ix), " ", _s(x.cy - (x.ry * 88) / 100), " Z");
        return _pathD(d, fill);
    }

    // ------------------------------------------------------------------
    // Behind-eye marks
    // ------------------------------------------------------------------

    function _behindEyesLocal(Ctx memory x) internal pure returns (string memory) {
        uint8 sp = x.t.species;

        if (sp == 5) {
            return string.concat(
                _ellipseRot(x.cx - x.eyeX, x.eyeY, (x.eyeR * 15) / 10, (x.eyeR * 185) / 100, 346, x.c.ear),
                _ellipseRot(x.cx + x.eyeX, x.eyeY, (x.eyeR * 15) / 10, (x.eyeR * 185) / 100, 14, x.c.ear)
            );
        }

        if (sp == 6) {
            return string.concat(
                _circle(x.cx - x.eyeX, x.eyeY + 8, (x.eyeR * 162) / 100, x.c.body),
                _circle(x.cx + x.eyeX, x.eyeY + 8, (x.eyeR * 162) / 100, x.c.body)
            );
        }

        if (sp == 7) {
            string memory out = _circle(x.cx - (x.rx * 74) / 100, x.cy - (x.ry * 50) / 100, (x.rx * 21) / 100, x.c.fleece);
            out = string.concat(out, _circle(x.cx - (x.rx * 60) / 100, x.cy - (x.ry * 80) / 100, (x.rx * 21) / 100, x.c.fleece));
            out = string.concat(out, _circle(x.cx - (x.rx * 32) / 100, x.cy - (x.ry * 98) / 100, (x.rx * 21) / 100, x.c.fleece));
            out = string.concat(out, _circle(x.cx, x.cy - (x.ry * 102) / 100, (x.rx * 21) / 100, x.c.fleece));
            out = string.concat(out, _circle(x.cx + (x.rx * 32) / 100, x.cy - (x.ry * 98) / 100, (x.rx * 21) / 100, x.c.fleece));
            out = string.concat(out, _circle(x.cx + (x.rx * 60) / 100, x.cy - (x.ry * 80) / 100, (x.rx * 21) / 100, x.c.fleece));
            out = string.concat(out, _circle(x.cx + (x.rx * 74) / 100, x.cy - (x.ry * 50) / 100, (x.rx * 21) / 100, x.c.fleece));
            return out;
        }

        return "";
    }

    // ------------------------------------------------------------------
    // Face
    // ------------------------------------------------------------------

    function _face(Ctx memory x) internal view returns (string memory) {
        uint256 muzzleRy = (x.t.species == 3 || x.t.species == 5) ? (x.ry * 38) / 100 : (x.ry * 34) / 100;
        uint256 op = x.t.blush == 0 ? 32 : 52;

        string memory out = _ellipse(x.cx, x.cy + 42, (x.rx * 50) / 100, muzzleRy, x.c.muzzle);
        out = string.concat(out, _blush(x, false, op));
        out = string.concat(out, _blush(x, true, op));
        // Separate group so the app can blink without moving the whole face.
        out = string.concat(out, '<g id="gp-eyes">', _eyes(x), '</g>');
        string memory sf = IGlowpetFaceArt(faceArt).specialFace(
            x.t.species, x.cx, x.cy, x.rx, x.ry, x.c.ink, x.c.ear, x.c.nose
        );
        if (bytes(sf).length == 0) sf = _noseMouth(x);
        out = string.concat(out, sf);
        out = string.concat(out, _marks(x));
        return out;
    }

    function _blush(Ctx memory x, bool right, uint256 op) internal pure returns (string memory) {
        uint256 cx = right ? x.cx + (x.rx * 62) / 100 : x.cx - (x.rx * 62) / 100;
        return string.concat(
            '<ellipse cx="', _s(cx), '" cy="', _s(x.cy + 30), '" rx="', _s((x.rx * 19) / 100),
            '" ry="', _s((x.ry * 12) / 100), '" fill="', x.c.blush, '" opacity="0.', _s(op / 10), _s(op % 10), '"/>'
        );
    }

    function _eyes(Ctx memory x) internal view returns (string memory) {
        return IGlowpetFaceArt(faceArt).eyes(
            x.t.species,
            x.t.eyeStyle,
            x.cx,
            x.eyeX,
            x.eyeY,
            x.eyeR,
            x.c.ink
        );
    }

    /// @dev Kept only as the original local implementation; unused once the
    ///      face renderer is delegated. The compiler prunes it from bytecode.
    function _eyesLocal(Ctx memory x) internal pure returns (string memory) {
        if (x.t.species == 5) {
            return string.concat(
                _pandaEye(x.cx - x.eyeX, x.eyeY, x.eyeR, x.t.eyeStyle, x.c.ink, false),
                _pandaEye(x.cx + x.eyeX, x.eyeY, x.eyeR, x.t.eyeStyle, x.c.ink, true)
            );
        }
        return string.concat(
            _eye(x.cx - x.eyeX, x.eyeY, x.eyeR, x.t.eyeStyle, x.c.ink, false),
            _eye(x.cx + x.eyeX, x.eyeY, x.eyeR, x.t.eyeStyle, x.c.ink, true)
        );
    }

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

    function _noseMouth(Ctx memory x) internal pure returns (string memory) {
        uint256 cx = x.cx;
        uint256 ny = x.cy + 32;

        string memory nose = string.concat("M ", _s(cx - 7), " ", _s(ny - 1));
        nose = string.concat(nose, " Q ", _s(cx), " ", _s(ny - 8), " ", _s(cx + 7), " ", _s(ny - 1));
        nose = string.concat(nose, " Q ", _s(cx + 4), " ", _s(ny + 7), " ", _s(cx), " ", _s(ny + 7));
        nose = string.concat(nose, " Q ", _s(cx - 4), " ", _s(ny + 7), " ", _s(cx - 7), " ", _s(ny - 1), " Z");

        if (x.t.mouthStyle == 0) {
            uint256 j = ny + 18;
            string memory stem = string.concat("M ", _s(cx), " ", _s(ny + 5), " L ", _s(cx), " ", _s(j));
            string memory mouth = string.concat("M ", _s(cx - 14), " ", _s(j));
            mouth = string.concat(mouth, " Q ", _s(cx - 7), " ", _s(j + 7), " ", _s(cx), " ", _s(j));
            mouth = string.concat(mouth, " Q ", _s(cx + 7), " ", _s(j + 7), " ", _s(cx + 14), " ", _s(j));
            return string.concat(_pathD(nose, x.c.nose), _stroke(stem, x.c.ink, 3), _stroke(mouth, x.c.ink, 3));
        }

        if (x.t.mouthStyle == 1) {
            uint256 j = ny + 26;
            string memory stem = string.concat("M ", _s(cx), " ", _s(ny + 5), " L ", _s(cx), " ", _s(j));
            string memory smile = string.concat("M ", _s(cx - 15), " ", _s(ny + 20));
            smile = string.concat(smile, " Q ", _s(cx), " ", _s(ny + 32), " ", _s(cx + 15), " ", _s(ny + 20));
            return string.concat(_pathD(nose, x.c.nose), _stroke(stem, x.c.ink, 3), _stroke(smile, x.c.ink, 4));
        }

        string memory stem = string.concat("M ", _s(cx), " ", _s(ny + 5), " L ", _s(cx), " ", _s(ny + 18));
        return string.concat(
            _pathD(nose, x.c.nose),
            _stroke(stem, x.c.ink, 3),
            _ellipse(cx, ny + 24, 8, 6, "#6b3f4a")
        );
    }

    function _frogMouth(Ctx memory x) internal pure returns (string memory) {
        string memory d = string.concat("M ", _s(x.cx - 44), " ", _s(x.cy + 34));
        d = string.concat(d, " Q ", _s(x.cx), " ", _s(x.cy + 66), " ", _s(x.cx + 44), " ", _s(x.cy + 34));
        return _stroke(d, x.c.ink, 5);
    }

    function _marksLocal(Ctx memory x) internal pure returns (string memory) {
        uint8 sp = x.t.species;

        if (sp == 0) {
            string memory out = "";
            for (uint256 i = 0; i < 3; i++) {
                uint256 y = x.cy + 36 + i * 9;
                uint256 len = 27 - i * 2;
                string memory lft = string.concat("M ", _s(x.cx - (x.rx * 50) / 100), " ", _s(y), " L ", _s(x.cx - (x.rx * 50) / 100 - len), " ", _s(y - 3 + i * 3));
                string memory rgt = string.concat("M ", _s(x.cx + (x.rx * 50) / 100), " ", _s(y), " L ", _s(x.cx + (x.rx * 50) / 100 + len), " ", _s(y - 3 + i * 3));
                out = string.concat(out, _stroke(lft, x.c.ink, 2), _stroke(rgt, x.c.ink, 2));
            }
            return out;
        }

        if (sp == 4) {
            string memory lft = string.concat("M ", _s(x.cx - (x.rx * 54) / 100), " ", _s(x.cy + 8));
            lft = string.concat(lft, " Q ", _s(x.cx - (x.rx * 98) / 100), " ", _s(x.cy + 2), " ", _s(x.cx - (x.rx * 93) / 100), " ", _s(x.cy + 34));
            lft = string.concat(lft, " Q ", _s(x.cx - (x.rx * 72) / 100), " ", _s(x.cy + 26), " ", _s(x.cx - (x.rx * 54) / 100), " ", _s(x.cy + 20), " Z");
            string memory rgt = string.concat("M ", _s(x.cx + (x.rx * 54) / 100), " ", _s(x.cy + 8));
            rgt = string.concat(rgt, " Q ", _s(x.cx + (x.rx * 98) / 100), " ", _s(x.cy + 2), " ", _s(x.cx + (x.rx * 93) / 100), " ", _s(x.cy + 34));
            rgt = string.concat(rgt, " Q ", _s(x.cx + (x.rx * 72) / 100), " ", _s(x.cy + 26), " ", _s(x.cx + (x.rx * 54) / 100), " ", _s(x.cy + 20), " Z");
            return string.concat(_pathD(lft, x.c.muzzle), _pathD(rgt, x.c.muzzle));
        }

        if (sp == 2) {
            return string.concat(
                _rect(x.cx - 9, x.cy + 58, 8, 11, 3, "#ffffff"),
                _rect(x.cx + 1, x.cy + 58, 8, 11, 3, "#ffffff")
            );
        }

        return "";
    }

    // ------------------------------------------------------------------
    // Eyewear
    // ------------------------------------------------------------------

    function _eyewear(Ctx memory x) internal view returns (string memory) {
        return IGlowpetFaceArt(faceArt).eyewear(
            x.t.eyewear,
            x.t.frameColor,
            x.cx,
            x.eyeX,
            x.eyeY,
            x.eyeR
        );
    }

    /// @dev Local implementation retained for reference; compiler-pruned.
    function _eyewearLocal(Ctx memory x) internal pure returns (string memory) {
        if (x.t.eyewear == 0) return "";

        uint256 left = x.cx - x.eyeX;
        uint256 right = x.cx + x.eyeX;
        uint256 ey = x.eyeY;
        uint256 r = (x.eyeR * 132) / 100;
        string memory frame = _frameColor(x.t.frameColor);
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

        if (x.t.eyewear == 1) {
            return string.concat(_lens(left, ey, r, frame, lens), _lens(right, ey, r, frame, lens), bridge, temples);
        }
        if (x.t.eyewear == 2) {
            uint256 w = (r * 185) / 100;
            uint256 h = (r * 155) / 100;
            return string.concat(
                _lensRect(left, ey, w, h, frame, lens),
                _lensRect(right, ey, w, h, frame, lens),
                bridge,
                temples
            );
        }
        if (x.t.eyewear == 3) {
            return string.concat(
                _ellipse(left, ey, r, r, "#2B2B30"),
                _ellipse(right, ey, r, r, "#2B2B30"),
                bridge,
                temples
            );
        }
        if (x.t.eyewear == 4) {
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
    // Accessories
    // ------------------------------------------------------------------

    function _accessory(Ctx memory x) internal pure returns (string memory) {
        uint256 top = x.cy - x.ry;

        if (x.t.accessory == 1) {
            string memory lft = string.concat("M 168 ", _s(top + 18), " L 144 ", _s(top - 6), " L 144 ", _s(top + 32), " Z");
            string memory rgt = string.concat("M 232 ", _s(top + 18), " L 256 ", _s(top - 6), " L 256 ", _s(top + 32), " Z");
            return string.concat(_pathD(lft, "#ff6b9d"), _pathD(rgt, "#ff6b9d"), _circle(200, top + 14, 11, "#ff9ab8"));
        }
        if (x.t.accessory == 2) {
            string memory d = string.concat("M 200 ", _s(top - 24), " l 8 17 18 3 -13 13 3 18 -16 -9 -16 9 3 -18 -13 -13 18 -3 z");
            return _pathD(d, "#ffd166");
        }
        if (x.t.accessory == 3) {
            string memory a = string.concat("M 200 ", _s(top + 8), " q -22 -8 -24 -32 q 24 3 24 32");
            string memory b = string.concat("M 200 ", _s(top + 8), " q 3 -24 19 -35 q 8 21 -19 35");
            return string.concat(_pathD(a, "#4ade80"), _pathD(b, "#86efac"));
        }
        if (x.t.accessory == 4) {
            string memory d = string.concat("M 166 ", _s(top + 10), " l 8 -24 13 12 13 -24 13 24 13 -12 8 24 z");
            return _pathD(d, "#fbbf24");
        }
        if (x.t.accessory == 5) {
            return string.concat(
                _ellipse(x.cx - x.rx + 3, x.cy + 6, 21, 28, "#3b82f6"),
                _ellipse(x.cx + x.rx - 3, x.cy + 6, 21, 28, "#3b82f6")
            );
        }
        return "";
    }
}

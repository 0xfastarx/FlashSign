'use strict';
const { ethers } = require('ethers');

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function isValidPrivateKey(privateKey) {
    return typeof privateKey === 'string' && privateKey.startsWith('0x') && privateKey.length === 66;
}

function isValidAddress(address) {
    try { return ethers.isAddress(address); } catch { return false; }
}

async function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

module.exports = { isValidPrivateKey, isValidAddress, sleep };

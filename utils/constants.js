'use strict';

// ===== NETWORK CONFIGURATION =====
const NETWORK_CONFIG = {
    BASE: { name: "Base Mainnet", chainId: 8453, explorer: "https://basescan.org", rpc: "https://mainnet.base.org" },
    ARBITRUM: { name: "Arbitrum Mainnet", chainId: 42161, explorer: "https://arbiscan.io", rpc: "https://arb1.arbitrum.io/rpc" },
    OPTIMISM: { name: "Optimism Mainnet", chainId: 10, explorer: "https://optimistic.etherscan.io", rpc: "https://mainnet.optimism.io" },
    POLYGON: { name: "Polygon Mainnet", chainId: 137, explorer: "https://polygonscan.com", rpc: "https://polygon-rpc.com" },
    ETHEREUM: { name: "Ethereum Mainnet", chainId: 1, explorer: "https://etherscan.io", rpc: "https://eth.llamarpc.com" }
};

// ===== MANUAL TRANSFER NETWORK CONFIGURATION =====
const MANUAL_NETWORKS = {
    sepolia_eth: { name: "Sepolia Ethereum", chainId: 11155111, rpc: "https://ethereum-sepolia-rpc.publicnode.com", explorer: "https://sepolia.etherscan.io" },
    base_sepolia: { name: "Base Sepolia", chainId: 84532, rpc: "https://base-testnet.api.pocket.network", explorer: "https://sepolia.basescan.org" },
    arc_testnet: { name: "Arc Tesnet", chainId: 5042002, rpc: "https://rpc.testnet.arc.network/", explorer: "" },
    bnb_testnet: { name: "BNB Tesnet", chainId: 97, rpc: "https://bsc-testnet-rpc.publicnode.com", explorer: "https://testnet.bscscan.com" },
    txene: { name: "Txene", chainId: 1096, rpc: "https://rpc-ubusuna.xeneascan.com", explorer: "https://ubusuna.xeneascan.com" }
};


// ===== GAS CONFIGURATION =====
const GAS_CONFIG = {
    GAS_LIMIT: 100000,
    MIN_ETH_BALANCE: 0.0001,
    CHECK_INTERVAL_MS: 10000,
    GAS_ESTIMATE_BUFFER: 1.2,
    TOKEN_SCAN_INTERVAL: 30000
};

// ===== TOKEN ABI =====
const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function name() view returns (string)"
];

// ===== TRACKER NETWORK CONFIGURATION (MAINNET) =====
const TRACKER_NETWORKS = {
    eth: { name: "Ethereum", chainId: 1, explorer: "https://etherscan.io", apiUrl: "https://eth.blockscout.com/api", hasFreeApi: true },
    bsc: { name: "BNB Smart Chain", chainId: 56, explorer: "https://bscscan.com", apiUrl: "https://api.etherscan.io/v2/api", hasFreeApi: false },
    polygon: { name: "Polygon PoS", chainId: 137, explorer: "https://polygonscan.com", apiUrl: "https://polygon.blockscout.com/api", hasFreeApi: true },
    avax: { name: "Avalanche C-Chain", chainId: 43114, explorer: "https://snowtrace.io", apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api", hasFreeApi: true },
    fantom: { name: "Fantom", chainId: 250, explorer: "https://ftmscan.com", apiUrl: "https://api.etherscan.io/v2/api", hasFreeApi: false },
    gnosis: { name: "Gnosis", chainId: 100, explorer: "https://gnosisscan.io", apiUrl: "https://gnosis.blockscout.com/api", hasFreeApi: true },
    celo: { name: "Celo", chainId: 42220, explorer: "https://celoscan.io", apiUrl: "https://celo.blockscout.com/api", hasFreeApi: true },
    cronos: { name: "Cronos", chainId: 25, explorer: "https://cronoscan.com", apiUrl: "https://api.etherscan.io/v2/api", hasFreeApi: false },
    arbitrum: { name: "Arbitrum One", chainId: 42161, explorer: "https://arbiscan.io", apiUrl: "https://arbitrum.blockscout.com/api", hasFreeApi: true },
    optimism: { name: "Optimism", chainId: 10, explorer: "https://optimistic.etherscan.io", apiUrl: "https://optimism.blockscout.com/api", hasFreeApi: true },
    base: { name: "Base", chainId: 8453, explorer: "https://basescan.org", apiUrl: "https://base.blockscout.com/api", hasFreeApi: true },
    linea: { name: "Linea", chainId: 59144, explorer: "https://lineascan.build", apiUrl: "https://api.etherscan.io/v2/api", hasFreeApi: false },
    zksync: { name: "zkSync Era", chainId: 324, explorer: "https://era.zksync.network", apiUrl: "https://zksync.blockscout.com/api", hasFreeApi: true },
    scroll: { name: "Scroll", chainId: 534352, explorer: "https://scrollscan.com", apiUrl: "https://scroll.blockscout.com/api", hasFreeApi: true },
    blast: { name: "Blast", chainId: 81457, explorer: "https://blastscan.io", apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/81457/etherscan/api", hasFreeApi: true },
    mantle: { name: "Mantle", chainId: 5000, explorer: "https://explorer.mantle.xyz", apiUrl: "https://api.routescan.io/v2/network/mainnet/evm/5000/etherscan/api", hasFreeApi: true }
};

module.exports = { NETWORK_CONFIG, ERC20_ABI, GAS_CONFIG, MANUAL_NETWORKS, TRACKER_NETWORKS };

'use strict';
const ModernUI = require('./ModernUI');

class InputHandler {
    constructor(rl) {
        this.rl = rl;
        this.ui = new ModernUI(); 
    }

    question(prompt) {
        return new Promise((resolve) => {
            if (!this.rl) {
                console.error('FATAL: InputHandler.question dipanggil tanpa readline interface.');
                resolve(''); 
                return;
            }
            
            const boxPadding = this.ui.getCenterPadding(this.ui.boxWidth);
            const leftPad = boxPadding + '  '; 
            const fullPrompt = `\n${leftPad}${this.ui.theme.secondary}» ${prompt}:${this.ui.theme.reset} `;
            this.rl.question(fullPrompt, (answer) => {
                resolve(answer.trim());
            });
        });
    }

    // FIX: Added missing close() method to prevent crash when GitHubPasswordSync.close() is called
    close() {
        if (this.rl) {
            try {
                this.rl.close();
            } catch (e) {
                // Ignore close errors
            }
        }
    }
}

module.exports = InputHandler;

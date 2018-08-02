const colors = require('colors');

// Taken from Welcome to Nightvale.
const quotes = [
    `People are beautiful when they do beautiful things.`,
    `In terms of tacos, she was doing fine.`,
    `You believe in mountains, right? Not everyone does.`,
    `It is a terrible, terrible beauty that I do not understand.`,
    `A million dollars isn’t cool. You know what’s cool? A basilisk.`,
    `Dress your dog for the job you want, not the job you have.`,
    `Dance like the government is watching.`,
    `There is no proof you exist. Only evidence.`,
    `Welcome to 2018. The year we finally do it. The year we eat the sun.`,
    `Bite your tongue. Fun, right?`,
    `I like my coffee like I like my nights: dark, endless, and impossible to sleep through.`,
    `There is a thin semantic line separating weird and beautiful, and that line is covered in jellyfish.`,
    `If it looks like a duck, and it quacks like a duck, you should not be so quick to jump to conclusions.`,
    `Confused? At a loss for what to do? Wow, sounds like you're human. Good Luck.`,
    `Wonderwall is the only 90's song visible from space.`,
    `Say what you will about dance, but language is a limited form of expression.`,
    `Remember that all sentences must have a noun, a verb, and the phrase "foolish mortals".`,
    `A rose by any other name is called something else.`,
    `You say potato, I say potato. Potato. Potato. Potato. Potato. Potato. Yes, this is very good. Let's keep going. Potato. Potato. Potato...`,
    `Drake would you like to add you to his professional network on LinkedIn.`,
    `Fool me once, shame on you. Fool me twice, now you're just being an asshole.`,
];

module.exports = {
    printQuote() {
        const quote = quotes[Math.floor(Math.random() * quotes.length)];
        console.log();
        console.log(`Quote for the day: "${colors.gray(colors.italic(quote))}"`);
    },
};

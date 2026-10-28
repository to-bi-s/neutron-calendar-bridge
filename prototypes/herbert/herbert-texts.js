/*
 * Herbert's lines, in one place. English only for the prototype; when he moves
 * into the app these go through the six-language catalogs (src/locales/).
 * Plain words, short: the speech bubble is 200 px wide.
 */
window.HERBERT_TEXTS = {
    // Said once when the window opens, by the hour of the day.
    greetingMorning: 'Good morning! Herbert reporting for duty.',
    greetingAfternoon: 'Good afternoon! Your calendars are in good hooves.',
    greetingEvening: 'Good evening! Still delivering, same as always.',
    greetingNight: 'Up late? I’ll keep watch. Rest when you can.',

    // Everything is fine.
    content: 'All is well. Everything is in sync.',

    // A sync failed.
    worried: 'Oh no, a sync went wrong. Please have a look at the app.',

    // A sample line for the demo's "Talking" button.
    talkingSample: 'Express delivery, straight across the rainbow bridge!',

    // Now and then, never more than one at a time, never while he sleeps or worries.
    encouragements: [
        'Just so you know: you’re amazing.',
        'Whatever today brings, you’ve got this.',
        'A small reminder that you’re doing great.',
        'You’re doing better than you think.',
        'Take a breath. You’re wonderful.',
    ],
};

// js/features/tour.js

import { getTemplate } from '../utils.js';

export class FeatureTour {
    constructor(steps) {
        this.steps = steps;
        this.currentStepIndex = 0;
        this.domElements = {};
        this.start = this.start.bind(this);
        this.end = this.end.bind(this);
        this.nextStep = this.nextStep.bind(this);
        this.prevStep = this.prevStep.bind(this);
        this.handleResize = this.handleResize.bind(this);
    }
    createDOMElements() {
        this.domElements.overlay = document.createElement('div');
        this.domElements.overlay.id = 'tour-overlay';
        this.domElements.overlay.onclick = this.end;
        this.domElements.highlightBox = document.createElement('div');
        this.domElements.highlightBox.id = 'tour-highlight-box';
        this.domElements.tooltip = document.createElement('div');
        this.domElements.tooltip.id = 'tour-tooltip';
        this.domElements.tooltip.appendChild(getTemplate('template-tour-tooltip'));
        document.body.appendChild(this.domElements.overlay);
        document.body.appendChild(this.domElements.highlightBox);
        document.body.appendChild(this.domElements.tooltip);
        this.domElements.title = this.domElements.tooltip.querySelector('.tour-tooltip-title');
        this.domElements.content = this.domElements.tooltip.querySelector('.tour-tooltip-content');
        this.domElements.customDemoContainer = this.domElements.tooltip.querySelector('.tour-custom-demo');
        this.domElements.stepCounter = this.domElements.tooltip.querySelector('.tour-tooltip-step-counter');
        this.domElements.skipButton = this.domElements.tooltip.querySelector('.tour-skip-button');
        this.domElements.prevButton = this.domElements.tooltip.querySelector('.tour-prev-button');
        this.domElements.nextButton = this.domElements.tooltip.querySelector('.tour-next-button');
    }
    attachEventListeners() {
        this.domElements.skipButton.addEventListener('click', this.end);
        this.domElements.nextButton.addEventListener('click', this.nextStep);
        this.domElements.prevButton.addEventListener('click', this.prevStep);
        window.addEventListener('resize', this.handleResize);
    }
    handleResize() {
        this.showStep(this.currentStepIndex);
    }
    start() {
        if (this.steps.length === 0) return;
        this.createDOMElements();
        this.attachEventListeners();
        this.currentStepIndex = 0;
        document.body.style.overflow = 'hidden';
        this.domElements.overlay.classList.add('active');
        this.showStep(this.currentStepIndex);
    }
    end() {
        localStorage.setItem('player_tour_completed', 'true');
        document.body.style.overflow = '';
        this.domElements.overlay.classList.remove('active');
        this.domElements.tooltip.classList.remove('active');
        setTimeout(() => {
            if (this.domElements.overlay) this.domElements.overlay.remove();
            if (this.domElements.highlightBox) this.domElements.highlightBox.remove();
            if (this.domElements.tooltip) this.domElements.tooltip.remove();
            window.removeEventListener('resize', this.handleResize);
        }, 300);
    }
    nextStep() {
        if (this.currentStepIndex < this.steps.length - 1) {
            this.currentStepIndex++;
            this.showStep(this.currentStepIndex);
        } else {
            this.end();
        }
    }
    prevStep() {
        if (this.currentStepIndex > 0) {
            this.currentStepIndex--;
            this.showStep(this.currentStepIndex);
        }
    }
    showStep(index) {
        const step = this.steps[index];
        this.domElements.customDemoContainer.style.display = 'none';
        this.domElements.customDemoContainer.innerHTML = '';

        if (!step) return;
        const targetElement = document.querySelector(step.element);
        if (!targetElement || targetElement.offsetParent === null) {
            this.nextStep();
            return;
        }
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const targetRect = targetElement.getBoundingClientRect();
        const highlightBox = this.domElements.highlightBox;
        highlightBox.style.width = `${targetRect.width + 10}px`;
        highlightBox.style.height = `${targetRect.height + 10}px`;
        highlightBox.style.top = `${targetRect.top - 5}px`;
        highlightBox.style.left = `${targetRect.left - 5}px`;
        highlightBox.style.borderRadius = window.getComputedStyle(targetElement).borderRadius;
        this.domElements.title.textContent = step.title;
        this.domElements.content.textContent = step.content;

        if (step.isCustomDemo === 'gallery') {
            const demoNode = getTemplate('template-tour-gallery-demo');
            if (demoNode) {
                this.domElements.customDemoContainer.appendChild(demoNode);
                this.domElements.customDemoContainer.style.display = 'block';
            }
        }

        this.domElements.stepCounter.textContent = `${index + 1} / ${this.steps.length}`;
        const tooltip = this.domElements.tooltip;
        // Reset classes first
        tooltip.className = 'tour-tooltip';
        setTimeout(() => {
            const tooltipRect = tooltip.getBoundingClientRect();
            let top, left;
            const margin = 15;
            switch (step.position) {
                case 'top':
                    top = targetRect.top - tooltipRect.height - margin;
                    left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2);
                    tooltip.classList.add('tour-tooltip-top');
                    // Add specific classes for mobile buttons
                    if (window.innerWidth <= 900) { // Check if it's mobile
                        if (step.element === '#mobile-playlist-btn') {
                            tooltip.classList.add('for-mobile-playlist-btn');
                        } else if (step.element === '#mobile-lyrics-btn') {
                            tooltip.classList.add('for-mobile-lyrics-btn');
                        }
                    }
                    break;
                case 'left': top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2); left = targetRect.left - tooltipRect.width - margin; tooltip.classList.add('tour-tooltip-left'); break;
                case 'right': top = targetRect.top + (targetRect.height / 2) - (tooltipRect.height / 2); left = targetRect.right + margin; tooltip.classList.add('tour-tooltip-right'); break;
                default: top = targetRect.bottom + margin; left = targetRect.left + (targetRect.width / 2) - (tooltipRect.width / 2); tooltip.classList.add('tour-tooltip-bottom'); break;
            }
            if (left < 10) left = 10;
            if (top < 10) top = 10;
            if (left + tooltipRect.width > window.innerWidth - 10) left = window.innerWidth - tooltipRect.width - 10;
            if (top + tooltipRect.height > window.innerHeight - 10) top = window.innerHeight - tooltipRect.height - 10;
            tooltip.style.top = `${top}px`;
            tooltip.style.left = `${left}px`;
            tooltip.classList.add('active');
        }, 10);
        this.domElements.prevButton.disabled = index === 0;
        this.domElements.nextButton.textContent = (index === this.steps.length - 1) ? '完成' : '下一步';
    }
}